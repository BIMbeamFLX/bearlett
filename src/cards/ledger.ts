// A card mint's rules (docs/CARDS-LNURLCASH.md, The card mint), without
// I/O: issue a card to its first holder, move it when its holder asks and
// vouch for the move, refuse every other burn of a card, answer lookups.
// A card mint wraps this in LUD-25 HTTP: tests/cards/mint.ts does, and so
// does the 600B TCG server.
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, equalBytes, hexToBytes} from '../spec/bytes.ts'
import {signCertificate} from '../spec/certificate.ts'
import {decodeCp1} from '../spec/encoding.ts'
import {
  checkSpend,
  decodeSpend,
  timeClaimProblem,
  type Spend
} from '../spec/notes.ts'
import {spendDomain} from '../spec/spend.ts'
import {
  buildConsignment,
  signGenesis,
  signMove,
  verifyConsignment,
  type Consignment
} from './proofs.ts'
import {
  cardNote,
  decodeState,
  encodeState,
  genesisState,
  moveProblem,
  type CardState
} from './state.ts'

export const CARD_MSAT = 1000
export const ONLY_MOVES = 'Cards move only by transition.'
// the reasons lnurl-mint gives, so a LUD-25 wallet reads them the same
export const UNKNOWN = 'Unknown note.'
export const SPENT = 'Note already spent.'
export const IN_USE = 'That note key is already in use.'

export type Refusal = {refused: string}
export type Live = {q: Uint8Array; amountMsat: number; c: string}
export type Moved = {c: string; receipt: Uint8Array; consignment: Consignment}

/** The callback's parameters, as the request carried them. */
export type BurnRequest = {
  k1s: string[]
  p1?: string
  state?: string
  amount?: string
  p2?: string
  pr?: string
}

type Record = {states: CardState[]; genesis: Uint8Array; receipts: Uint8Array[]}

const refuse = (refused: string): Refusal => ({refused})
const opens = (spend: Spend, domain: string): Refusal | null => {
  const check = checkSpend(spend, domain)
  return check.status === 'valid'
    ? null
    : refuse(`The spend does not open the card: ${check.reason}.`)
}
const HEX = /^(?:[0-9a-f]{2})+$/

export type LedgerOptions = {
  /** the card mint's LUD-25 withdraw endpoint */
  withdraw: string
  /** the collection's issuer (catalog) key: signs geneses and receipts */
  issuerKey: Uint8Array
  /** the LUD-25 mint key: signs cs1 certificates */
  mintKey: Uint8Array
  /** unix seconds, for time claims */
  now?: () => number
}

export class CardLedger {
  readonly withdraw: string
  readonly domain: string
  readonly issuer: Uint8Array
  readonly mintPubkey: string
  private readonly issuerKey: Uint8Array
  private readonly mintKey: Uint8Array
  private readonly now: () => number
  /** by asset id */
  private readonly records = new Map<string, Record>()
  /** note key of a card's current state, to its asset id */
  private readonly live = new Map<string, string>()
  /** note keys of every earlier state, to their asset id */
  private readonly spent = new Map<string, string>()
  /** owner key, to the asset ids it holds */
  private readonly owners = new Map<string, Set<string>>()

  constructor(options: LedgerOptions) {
    this.withdraw = options.withdraw
    this.domain = spendDomain(options.withdraw)
    this.issuerKey = options.issuerKey
    this.issuer = schnorr.getPublicKey(options.issuerKey)
    this.mintKey = options.mintKey
    this.mintPubkey = bytesToHex(secp256k1.getPublicKey(options.mintKey, true))
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /** Rebuilds a ledger from the consignments it wrote, each checked in full. */
  static restore(options: LedgerOptions, saved: Consignment[]): CardLedger {
    const ledger = new CardLedger(options)
    for (const consignment of saved) {
      const card = verifyConsignment(consignment, ledger.issuer)
      if (typeof card === 'string') throw new Error(`Not restorable: ${card}.`)
      const receipts = consignment.receipts.map(hexToBytes)
      ledger.keep(card.states, hexToBytes(consignment.genesis), receipts)
    }
    return ledger
  }

  /** Everything needed to restore this ledger. */
  save(): Consignment[] {
    return [...this.records.keys()].map(id => this.consignment(id)!)
  }

  private keep(
    states: CardState[],
    genesis: Uint8Array,
    receipts: Uint8Array[]
  ) {
    const id = bytesToHex(states[0].assetId)
    if (this.records.has(id)) throw new Error('That card is issued already.')
    this.records.set(id, {states, genesis, receipts})
    states.forEach((state, i) => {
      const q = bytesToHex(cardNote(state).q)
      if (i < states.length - 1) this.spent.set(q, id)
      else this.live.set(q, id)
    })
    this.hold(states[states.length - 1].owner, id)
  }

  private hold(owner: Uint8Array, id: string) {
    const key = bytesToHex(owner)
    const held = this.owners.get(key) ?? new Set()
    held.add(id)
    this.owners.set(key, held)
  }

  private release(owner: Uint8Array, id: string) {
    const key = bytesToHex(owner)
    this.owners.get(key)?.delete(id)
    if (!this.owners.get(key)?.size) this.owners.delete(key)
  }

  /** Issues one card to its first holder; a card and serial are issued once. */
  issue(name: string, description: string, owner: Uint8Array): Consignment {
    const state = genesisState(this.issuer, name, description, owner)
    this.keep([state], signGenesis(this.issuerKey, state, this.domain), [])
    return this.consignment(bytesToHex(state.assetId))!
  }

  consignment(assetId: string): Consignment | null {
    const record = this.records.get(assetId)
    if (!record) return null
    return buildConsignment(
      this.withdraw,
      this.issuer,
      record.states,
      record.genesis,
      record.receipts
    )
  }

  /** The live cards an owner key holds. */
  byOwner(owner: Uint8Array): Consignment[] {
    return [...(this.owners.get(bytesToHex(owner)) ?? [])].map(id =>
      this.consignment(id)!
    )
  }

  private certified(q: Uint8Array): Live {
    return {
      q,
      amountMsat: CARD_MSAT,
      c: signCertificate(CARD_MSAT, q, this.mintKey)
    }
  }

  /** LUD-25 informational GET by `?p=`. */
  lookup(q: Uint8Array): Live | Refusal {
    const key = bytesToHex(q)
    if (this.live.has(key)) return this.certified(q)
    return refuse(this.spent.has(key) ? SPENT : UNKNOWN)
  }

  /** LUD-25 informational GET by `?k1=`: only a spend that opens a live card. */
  lookupSpend(k1: string): Live | Refusal {
    const spend = decodeSpend(k1)
    if (!spend) return refuse('That is not a spend.')
    const known = this.lookup(spend.q)
    if ('refused' in known) return known
    return opens(spend, this.domain) ?? known
  }

  /** The callback: a move of one card, answered again the same way if asked again. */
  burn(request: BurnRequest): Moved | Refusal {
    const {k1s, p1, state} = request
    if (
      k1s.length !== 1 ||
      !p1 ||
      state === undefined ||
      request.amount !== undefined ||
      request.p2 !== undefined ||
      request.pr !== undefined
    )
      return refuse(ONLY_MOVES)
    const spend = decodeSpend(k1s[0])
    if (spend?.kind !== 'script') return refuse('That is not a card’s spend.')
    const q = bytesToHex(spend.q)
    const id = this.live.get(q) ?? this.spent.get(q)
    if (!id) return refuse(UNKNOWN)
    const record = this.records.get(id)!
    const at = record.states.findIndex(s => bytesToHex(cardNote(s).q) === q)
    const current = record.states[at]
    const closed = opens(spend, this.domain)
    if (closed) return closed
    const late = timeClaimProblem(spend.claim, this.now(), 0)
    if (late) return refuse(`The spend is not due: ${late}.`)
    const revealed = spend.witness[spend.witness.length - 1]
    if (!revealed || !equalBytes(revealed, encodeState(current)))
      return refuse('The spend reveals another state.')
    const next = HEX.test(state) ? decodeState(hexToBytes(state)) : null
    if (!next) return refuse('The next state does not decode.')
    const to = decodeCp1(p1)
    if (!to) return refuse('p1 is not a note key.')
    // asked again: the same move gets the same answer, anything else nothing
    if (at < record.states.length - 1) {
      const moved = record.states[at + 1]
      if (
        !equalBytes(encodeState(moved), encodeState(next)) ||
        !equalBytes(cardNote(moved).q, to)
      )
        return refuse(SPENT)
      return {
        c: this.certified(to).c,
        receipt: record.receipts[at],
        consignment: this.consignment(id)!
      }
    }
    const problem = moveProblem(current, next)
    if (problem) return refuse(`That is not the card’s next state: ${problem}.`)
    if (!equalBytes(cardNote(next).q, to))
      return refuse('The next state does not lock to p1.')
    const toKey = bytesToHex(to)
    if (this.live.has(toKey) || this.spent.has(toKey)) return refuse(IN_USE)
    const receipt = signMove(this.issuerKey, current, next, this.domain)
    record.states.push(next)
    record.receipts.push(receipt)
    this.live.delete(q)
    this.spent.set(q, id)
    this.live.set(toKey, id)
    this.release(current.owner, id)
    this.hold(next.owner, id)
    return {
      c: this.certified(to).c,
      receipt,
      consignment: this.consignment(id)!
    }
  }
}

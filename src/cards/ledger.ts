// A card mint's rules (docs/CARDS-LNURLCASH.md, The card mint), without
// I/O: issue a card to its first holder, move it when its holder asks and
// vouch for the move, refuse every other burn of a card, answer lookups.
// A card mint wraps this in LUD-25 HTTP: tests/cards/mint.ts does, and so
// does the 600B TCG server.
import {secp256k1, schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, equalBytes, hexToBytes} from '../spec/bytes.ts'
import {signCertificate} from '../spec/certificate.ts'
import {decodeCp1, isPointX} from '../spec/encoding.ts'
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
/** The lookup's answer: an owner key's live cards, and whether it ever held one. */
export type Holdings = {cards: Consignment[]; used: boolean}
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
  /** the card mint's LUD-25 withdraw endpoint, as every card names it */
  withdraw: string
  /** the collection's issuer (catalog) key: signs geneses and receipts */
  issuerKey: Uint8Array
  /** the LUD-25 mint key: signs cs1 certificates */
  mintKey: Uint8Array
  /** unix seconds, for time claims */
  now?: () => number
  /**
   * Writes a card's new consignment down, synchronously, before the ledger
   * holds the change in memory. If it throws, nothing changed: a mint must
   * never vouch for a move it could forget on a restart.
   */
  persist?: (consignment: Consignment) => void
}

export class CardLedger {
  readonly withdraw: string
  readonly domain: string
  readonly issuer: Uint8Array
  readonly mintPubkey: string
  private readonly issuerKey: Uint8Array
  private readonly mintKey: Uint8Array
  private readonly now: () => number
  private readonly persist: (consignment: Consignment) => void
  /** by asset id */
  private readonly records = new Map<string, Record>()
  /** note key of a card's current state, to its asset id */
  private readonly live = new Map<string, string>()
  /** note keys of every earlier state, to their asset id */
  private readonly spent = new Map<string, string>()
  /** owner key, to the asset ids it holds */
  private readonly owners = new Map<string, Set<string>>()
  /** every owner key that ever held a card here */
  private readonly seen = new Set<string>()

  constructor(options: LedgerOptions) {
    // the form a holder compares, so `https://host` names `https://host/`
    this.withdraw = new URL(options.withdraw).toString()
    this.domain = spendDomain(this.withdraw)
    this.issuerKey = options.issuerKey
    this.issuer = schnorr.getPublicKey(options.issuerKey)
    this.mintKey = options.mintKey
    this.mintPubkey = bytesToHex(secp256k1.getPublicKey(options.mintKey, true))
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.persist = options.persist ?? (() => {})
  }

  /**
   * Rebuilds a ledger from the consignments it wrote, each checked in full.
   * A card that does not check out is left out and named to `skip` by its
   * place in `saved`, so one bad record cannot keep the card mint from
   * starting; a changed issuer key or withdraw URL is a misconfiguration
   * and refuses the whole start.
   */
  static restore(
    options: LedgerOptions,
    saved: Consignment[],
    skip: (problem: string, at: number) => void = () => {}
  ): CardLedger {
    // keep() only fills memory: nothing read back is written again
    const ledger = new CardLedger(options)
    const issuer = bytesToHex(ledger.issuer)
    for (const [at, consignment] of saved.entries()) {
      const named = consignment as Partial<Consignment> | null
      if (
        (typeof named?.issuer === 'string' && named.issuer !== issuer) ||
        (typeof named?.mint === 'string' && named.mint !== ledger.withdraw)
      )
        throw new Error(
          'Not restorable: the cards name another issuer key or withdraw URL.'
        )
      const card = verifyConsignment(consignment, ledger.issuer)
      if (typeof card === 'string') {
        skip(`Left out a card that does not check out: ${card}.`, at)
        continue
      }
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
      this.seen.add(bytesToHex(state.owner))
      const q = bytesToHex(cardNote(state).q)
      if (i < states.length - 1) this.spent.set(q, id)
      else this.live.set(q, id)
    })
    this.hold(states[states.length - 1].owner, id)
  }

  private hold(owner: Uint8Array, id: string) {
    const key = bytesToHex(owner)
    this.seen.add(key)
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
    if (!isPointX(owner)) throw new Error('A card is issued to a key only.')
    const state = genesisState(this.issuer, name, description, owner)
    const id = bytesToHex(state.assetId)
    if (this.records.has(id)) throw new Error('That card is issued already.')
    const genesis = signGenesis(this.issuerKey, state, this.domain)
    const consignment = buildConsignment(
      this.withdraw,
      this.issuer,
      [state],
      genesis,
      []
    )
    this.persist(consignment)
    this.keep([state], genesis, [])
    return consignment
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

  /** The lookup by `?owner=`: a holder's scan counts a key that ever held a card. */
  lookupOwner(owner: Uint8Array): Holdings {
    return {
      cards: this.byOwner(owner),
      used: this.seen.has(bytesToHex(owner))
    }
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
    const consignment = buildConsignment(
      this.withdraw,
      this.issuer,
      [...record.states, next],
      record.genesis,
      [...record.receipts, receipt]
    )
    // written down first: if that fails, the card has not moved
    this.persist(consignment)
    record.states.push(next)
    record.receipts.push(receipt)
    this.live.delete(q)
    this.spent.set(q, id)
    this.live.set(toKey, id)
    this.release(current.owner, id)
    this.hold(next.owner, id)
    return {c: this.certified(to).c, receipt, consignment}
  }
}

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
import {isAllowedServiceUrl} from '../lnurl/net.ts'
import {
  buildConsignment,
  MAX_STATES,
  signGenesis,
  signMove,
  verifyConsignment,
  type Card,
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
/** A card at the most states this card mint allows: a wallet shows it as is. */
export const MOVED_OUT =
  'This card has moved as often as this card mint allows.'

export type Refusal = {refused: string}
export type Live = {q: Uint8Array; amountMsat: number; c: string}
/** The lookup's answer: an owner key's live cards, and whether it ever held one. */
export type Holdings = {cards: Consignment[]; used: boolean}
export type Moved = {c: string; receipt: Uint8Array; consignment: Consignment}

/** One card to issue: its id in the collection, its serial, its first holder. */
export type CardToIssue = {name: string; description: string; owner: Uint8Array}

/**
 * Cards written down but not held yet: keep() holds them once the caller's
 * transaction committed; abandon() gives their ids back after a rollback.
 */
export type PendingIssue = {
  consignments: Consignment[]
  keep: () => void
  abandon: () => void
}

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
const X_ONLY = /^[0-9a-f]{64}$/

/** Whether a history, as hex states, is where another one started. */
const isPrefix = (shorter: string[], longer: string[]) =>
  shorter.length <= longer.length && shorter.every((s, i) => s === longer[i])

/** The asset id a record names in its first state, read without checking it. */
const assetIdOf = (consignment: unknown): string | null => {
  const first = (consignment as Partial<Consignment> | null)?.states?.[0]
  const hex = typeof first === 'string' ? first.toLowerCase() : ''
  const state = HEX.test(hex) ? decodeState(hexToBytes(hex)) : null
  return state ? bytesToHex(state.assetId) : null
}

/** A record's states, when it has a list of them. */
const statesOf = (consignment: unknown): string[] | null => {
  const states = (consignment as Partial<Consignment> | null)?.states
  return Array.isArray(states) && states.every(s => typeof s === 'string')
    ? states
    : null
}

export type LedgerOptions = {
  /** the card mint's LUD-25 withdraw endpoint, as every card names it */
  withdraw: string
  /** the collection's issuer (catalog) key: signs geneses and receipts */
  issuerKey: Uint8Array
  /** the LUD-25 mint key: signs cs1 certificates */
  mintKey: Uint8Array
  /** unix seconds, for time claims */
  now?: () => number
  /** the most states a card may reach here: MAX_STATES, or fewer, at least 1 */
  maxStates?: number
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
  private readonly maxStates: number
  /** by asset id */
  private readonly records = new Map<string, Record>()
  /**
   * the note key of every state of every card, to its asset id and its
   * place in the history: live when it is the last one
   */
  private readonly notes = new Map<string, {id: string; at: number}>()
  /** owner key, to the asset ids it holds */
  private readonly owners = new Map<string, Set<string>>()
  /** every owner key that ever held a card here */
  private readonly seen = new Set<string>()
  /** asset ids of cards left out at restore: issued once, so never again */
  private readonly quarantined = new Set<string>()
  /** asset ids written down by issuePending, not kept or abandoned yet */
  private readonly reserved = new Set<string>()

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
    const maxStates = options.maxStates ?? MAX_STATES
    if (!Number.isSafeInteger(maxStates) || maxStates < 1)
      throw new Error('maxStates is a whole number, at least 1.')
    this.maxStates = Math.min(maxStates, MAX_STATES)
  }

  /**
   * Rebuilds a ledger from the consignments it wrote: the latest of every
   * card, which a card mint keeps by replacing a card's record on every
   * write (every move writes the whole history, so a log of every write
   * grows with the square of the moves). Of each card the longest history
   * that checks out in full is kept (between histories of one length, the
   * first in hex order, whatever the order of the records); an earlier
   * version of it is passed over unchecked, and any other history (a fork,
   * as a re-sign after restoring an old backup makes) is named to `skip`.
   *
   * A record that does not check out is left out and named to `skip` by its
   * place in `saved`, so one damaged record cannot keep the card mint from
   * starting, and its id is never issued again. A record that names another
   * well-formed issuer key or withdraw URL refuses the start, damaged or
   * not: a card mint's own store never holds one, so this fails safe. So
   * does a store whose records all fail.
   */
  static restore(
    options: LedgerOptions,
    saved: Consignment[],
    skip: (problem: string, at: number) => void = () => {}
  ): CardLedger {
    // keep() only fills memory: nothing read back is written again
    const ledger = new CardLedger(options)
    const issuer = bytesToHex(ledger.issuer)
    const damaged = (consignment: unknown, at: number, problem: string) => {
      ledger.quarantine(consignment)
      skip(`Left out a card that does not check out: ${problem}.`, at)
    }
    // grouped by card from the first state alone: only what is kept is checked in full
    const byCard = new Map<string, {record: Consignment; at: number}[]>()
    for (const [at, record] of saved.entries()) {
      const named = record as Partial<Consignment> | null
      if (
        (typeof named?.issuer === 'string' &&
          X_ONLY.test(named.issuer) &&
          named.issuer !== issuer) ||
        (typeof named?.mint === 'string' &&
          isAllowedServiceUrl(named.mint) &&
          named.mint !== ledger.withdraw)
      )
        throw new Error(
          'Not restorable: a card names another issuer key or withdraw URL, ' +
            'which this card mint’s own records never do.'
        )
      const id = assetIdOf(record)
      if (!id || !statesOf(record)) {
        const card = verifyConsignment(record, ledger.issuer)
        damaged(record, at, typeof card === 'string' ? card : 'not its card')
        continue
      }
      const found = byCard.get(id)
      if (found) found.push({record, at})
      else byCard.set(id, [{record, at}])
    }
    for (const found of byCard.values()) {
      const ordered = [...found].sort((a, b) => {
        const [x, y] = [statesOf(a.record)!, statesOf(b.record)!]
        if (x.length !== y.length) return y.length - x.length
        const [p, q] = [x.join(), y.join()]
        return p < q ? -1 : p > q ? 1 : a.at - b.at
      })
      let kept: Card | null = null
      for (const {record, at} of ordered) {
        const states = statesOf(record)!
        if (kept && isPrefix(states, kept.consignment.states)) continue
        const card = verifyConsignment(record, ledger.issuer)
        if (typeof card === 'string') damaged(record, at, card)
        else if (!kept) kept = card
        else
          skip('Left out a history that forks the one kept of this card.', at)
      }
      if (kept)
        ledger.keep(
          kept.states,
          hexToBytes(kept.consignment.genesis),
          kept.consignment.receipts.map(hexToBytes)
        )
    }
    if (saved.length && !ledger.records.size)
      throw new Error('Not restorable: none of the cards checks out.')
    return ledger
  }

  /** Keeps a card left out at restore from ever being issued again. */
  private quarantine(consignment: unknown) {
    const id = assetIdOf(consignment)
    if (id && !this.records.has(id)) this.quarantined.add(id)
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
    states.forEach((state, at) => {
      this.seen.add(bytesToHex(state.owner))
      this.notes.set(bytesToHex(cardNote(state).q), {id, at})
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

  /**
   * Issues one card to its first holder. A card and serial are issued once:
   * the ledger refuses one it holds or left out at restore, and a card mint
   * keeps its serial counter across restarts for a card it never saw.
   */
  issue(name: string, description: string, owner: Uint8Array): Consignment {
    const pending = this.issuePending([{name, description, owner}])
    pending.keep()
    return pending.consignments[0]
  }

  /**
   * Issues cards all or none, held only once the card mint says so. Each is
   * written down with `persist` now, and their ids are reserved: no other
   * issue gets them. The ledger holds them when `keep` is called, and gives
   * the ids back when `abandon` is.
   *
   * All or none holds on disk only if the card mint writes the pack in one
   * transaction and rolls it back when this throws part way (the ids are
   * given back then), and it calls keep() only after a successful COMMIT,
   * abandon() after a rollback. Until keep(), no lookup, move or issue sees
   * the cards. keep() after abandon() throws: the ids are free again.
   * abandon() after keep() does nothing.
   */
  issuePending(cards: CardToIssue[]): PendingIssue {
    const ids = new Set<string>()
    const issued = cards.map(({name, description, owner}) => {
      if (!isPointX(owner)) throw new Error('A card is issued to a key only.')
      const state = genesisState(this.issuer, name, description, owner)
      const id = bytesToHex(state.assetId)
      if (
        this.records.has(id) ||
        this.quarantined.has(id) ||
        this.reserved.has(id) ||
        ids.has(id)
      )
        throw new Error('That card is issued already.')
      ids.add(id)
      const genesis = signGenesis(this.issuerKey, state, this.domain)
      const consignment = buildConsignment(
        this.withdraw,
        this.issuer,
        [state],
        genesis,
        []
      )
      return {state, id, genesis, consignment}
    })
    for (const id of ids) this.reserved.add(id)
    let open = true
    let abandoned = false
    const release = () => {
      for (const id of ids) this.reserved.delete(id)
      open = false
    }
    try {
      for (const {consignment} of issued) this.persist(consignment)
    } catch (err) {
      release()
      throw err
    }
    return {
      consignments: issued.map(card => card.consignment),
      keep: () => {
        // its ids went back, and may be another pack's now
        if (abandoned) throw new Error('That pack was abandoned.')
        if (!open) return
        release()
        for (const {state, genesis} of issued) this.keep([state], genesis, [])
      },
      abandon: () => {
        if (!open) return
        release()
        abandoned = true
      }
    }
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

  private isLive(note: {id: string; at: number}): boolean {
    return note.at === this.records.get(note.id)!.states.length - 1
  }

  /** LUD-25 informational GET by `?p=`. */
  lookup(q: Uint8Array): Live | Refusal {
    const note = this.notes.get(bytesToHex(q))
    if (!note) return refuse(UNKNOWN)
    return this.isLive(note) ? this.certified(q) : refuse(SPENT)
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
    const note = this.notes.get(q)
    if (!note) return refuse(UNKNOWN)
    // the signature before anything else: a spend that does not open the
    // card costs one check, however long the card's history
    const closed = opens(spend, this.domain)
    if (closed) return closed
    const {id, at} = note
    const record = this.records.get(id)!
    const current = record.states[at]
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
    if (record.states.length >= this.maxStates) return refuse(MOVED_OUT)
    const problem = moveProblem(current, next)
    if (problem) return refuse(`That is not the card’s next state: ${problem}.`)
    if (!equalBytes(cardNote(next).q, to))
      return refuse('The next state does not lock to p1.')
    const toKey = bytesToHex(to)
    if (this.notes.has(toKey)) return refuse(IN_USE)
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
    this.notes.set(toKey, {id, at: at + 1})
    this.release(current.owner, id)
    this.hold(next.owner, id)
    return {c: this.certified(to).c, receipt, consignment}
  }
}

// The wallet's bookkeeping. Nothing in it is needed to recover funds held as
// key-path notes (the seed and the list of mints are); it records what the
// wallet knows so far, and which mint calls are still in flight.
import type {KeyRef} from './keys.ts'
import type {MintFee} from '../lnurl/pay.ts'
import type {Pack} from '../cards/holder.ts'
import type {Consignment} from '../cards/proofs.ts'
import type {NoteDesign} from './design.ts'

export type Hex = string

export type Mint = {
  /**
   * the mint's key everywhere in the state: its withdraw endpoint's host,
   * lowercased, port included, which is also what its branch is derived
   * from. Signatures bind the hostname alone (keys.ts's spendDomainOfHost).
   */
  domain: string
  /** LUD-03 informational endpoint, e.g. https://mint.example/w */
  withdrawLink: string
  /** the payRequest this wallet mints through */
  payUrl?: string
  /** pinned on first sight; a different key later is reported, not accepted */
  mintPubkey?: string
  fee?: MintFee
  name?: string
  addedAt: number
}

/** How the wallet opens a note. */
export type SpendRef =
  /** a key-path note on this wallet's own branch: its ck1 is re-derived */
  | {kind: 'key'; key: KeyRef}
  /** a bearer note: its hex preimage is the k1 short form */
  | {kind: 'preimage'; preimage: Hex}
  /** a spend received as is (ck1 or cw1), until it is rotated */
  | {kind: 'k1'; k1: string}
  /** this wallet's own key behind a CLTV leaf: spendable from `locktime` on */
  | {kind: 'timelock'; key: KeyRef; locktime: number}

export type NoteRole =
  /** part of the balance */
  | 'own'
  /** received, not rotated yet: someone else may still hold the spend */
  | 'incoming'
  /** made to be handed out; reclaimable until the recipient rotates it */
  | 'outgoing'
  /** this wallet's own, but only spendable from its locktime on */
  | 'locked'

export type NoteStatus = 'live' | 'pending' | 'spent'

export type Note = {
  q: Hex
  mint: string
  amountMsat: number
  /** SERVICE's cs1 for this note, verified against the pinned mintPubkey */
  c?: string
  spend: SpendRef
  role: NoteRole
  status: NoteStatus
  memo?: string
  createdAt: number
  updatedAt: number
}

export type Output = {q: Hex; spend?: SpendRef; role?: NoteRole; label: string}

/**
 * A mint call that changes state, written down before it is sent so a
 * crash or a lost answer can always be settled afterwards.
 */
export type Operation =
  | {
      id: string
      kind: 'mint'
      mint: string
      createdAt: number
      amountMsat: number
      pr: string
      verify?: string
      output: Output
    }
  | {
      id: string
      kind: 'burn'
      mint: string
      createdAt: number
      callback: string
      inputs: Hex[]
      k1s: string[]
      p1: Output
      /** set for a split: p1 is worth amountMsat, p2 the rest */
      split?: {amountMsat: number; p2: Output}
      /** what the wallet was doing, for the activity list */
      purpose: 'rotate' | 'merge' | 'send' | 'pay' | 'transfer' | 'claim'
      /** unknown: sent without an answer; retrying is a replay */
      state: 'prepared' | 'unknown'
    }
  | {
      id: string
      kind: 'melt'
      mint: string
      createdAt: number
      callback: string
      input: Hex
      k1: string
      pr: string
      amountMsat: number
      verify?: string
      state: 'prepared' | 'unknown' | 'in-flight'
    }

export type Activity = {
  id: string
  at: number
  kind:
    | 'mint'
    | 'receive'
    | 'send'
    | 'pay'
    | 'transfer'
    | 'reclaim'
    | 'recover'
    | 'address'
    | 'lock'
    | 'card'
  mint?: string
  amountMsat?: number
  text: string
}

export type LightningAddress = {username: string; mint: string; since: number}

/** A card mint (docs/CARDS-LNURLCASH.md), keyed like a mint by its host. */
export type CardMintRecord = {
  domain: string
  withdraw: string
  lookup: string
  /** the issuer key, hex: pinned on first sight, like a mint key */
  issuer: string
  packs: Pack[]
  addedAt: number
}

export type CardStatus =
  /** a key of this wallet holds it */
  | 'held'
  /** a move is sent and not answered yet: asking again is a replay */
  | 'moving'
  /** moved to someone else from here */
  | 'sent'
  /** at no key of this wallet any more, and not moved from here */
  | 'gone'

export type HeldCard = {
  /** the asset id, hex */
  id: string
  /** the card mint's domain */
  mint: string
  consignment: Consignment
  /** the index of the card key holding the current state, while it is this wallet's */
  index?: number
  status: CardStatus
  /** the move in flight, kept to ask again with the same bytes */
  move?: {callback: string; k1: string; p1: string; state: string}
  updatedAt: number
}

export type WalletState = {
  v: 1
  mints: Record<string, Mint>
  /** next unused index per mint and purpose: [wallet, change, address] */
  counters: Record<string, [number, number, number]>
  notes: Record<Hex, Note>
  operations: Record<string, Operation>
  activity: Activity[]
  addresses: Record<string, LightningAddress>
  cardMints: Record<string, CardMintRecord>
  /**
   * per card mint host: the first card key no card is known to have
   * reached. It is handed out again until one does, and outlives the card
   * mint's record, so a key once used is never handed out again.
   */
  cardKeys: Record<string, number>
  cards: Record<string, HeldCard>
  /**
   * invoices this wallet paid (invoiceText), to when: none is paid twice.
   * Kept 30 days, past the expiry of any invoice a wallet is usually handed.
   */
  paidInvoices: Record<string, number>
  settings: {
    gapLimit: number
    offline: boolean
    /** how handed-out notes look, from the Hangar's Note Designer */
    design?: NoteDesign
  }
}

export const emptyState = (): WalletState => ({
  v: 1,
  mints: {},
  counters: {},
  notes: {},
  operations: {},
  activity: [],
  addresses: {},
  cardMints: {},
  cardKeys: {},
  cards: {},
  paidInvoices: {},
  settings: {gapLimit: 20, offline: false}
})

/** Accepts only a state this version wrote; anything else starts over. */
export const isWalletState = (value: unknown): value is WalletState => {
  const s = value as WalletState
  return (
    typeof s === 'object' &&
    s !== null &&
    s.v === 1 &&
    typeof s.mints === 'object' &&
    typeof s.counters === 'object' &&
    typeof s.notes === 'object' &&
    typeof s.operations === 'object' &&
    Array.isArray(s.activity)
  )
}

export const ACTIVITY_LIMIT = 500

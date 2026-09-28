// What makes a card genuine (docs/CARDS-LNURLCASH.md, Signatures and
// Consignment): the issuer signs its genesis, the card mint signs every
// move, and a holder checks the whole history offline.
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToHex,
  equalBytes,
  hexToBytes,
  taggedHash,
  utf8ToBytes
} from '../spec/bytes.ts'
import {ZERO_AUX} from '../spec/derivation.ts'
import {isPointX} from '../spec/encoding.ts'
import {spendDomain} from '../spec/spend.ts'
import {isAllowedServiceUrl} from '../lnurl/net.ts'
import {
  cardAssetId,
  cardNote,
  decodeState,
  encodeState,
  moveProblem,
  stateHash,
  ZERO32,
  type CardState
} from './state.ts'

const domainBytes = (domain: string) => utf8ToBytes(domain.toLowerCase())

export const genesisDigest = (state: CardState, domain: string): Uint8Array =>
  taggedHash('LNURLcash/card/genesis/v0', stateHash(state), domainBytes(domain))

export const moveDigest = (
  prev: CardState,
  next: CardState,
  domain: string
): Uint8Array =>
  taggedHash(
    'LNURLcash/card/move/v0',
    stateHash(prev),
    stateHash(next),
    domainBytes(domain)
  )

/** The issuer's signature on a first state; the same bytes every time. */
export const signGenesis = (
  issuerKey: Uint8Array,
  state: CardState,
  domain: string
): Uint8Array => schnorr.sign(genesisDigest(state, domain), issuerKey, ZERO_AUX)

/** The card mint's receipt for a move; the same bytes every time. */
export const signMove = (
  issuerKey: Uint8Array,
  prev: CardState,
  next: CardState,
  domain: string
): Uint8Array =>
  schnorr.sign(moveDigest(prev, next, domain), issuerKey, ZERO_AUX)

const verifies = (sig: Uint8Array, digest: Uint8Array, issuer: Uint8Array) => {
  try {
    return schnorr.verify(sig, digest, issuer)
  } catch {
    return false
  }
}

export type Consignment = {
  v: 0
  /** the card mint's LUD-25 withdraw endpoint */
  mint: string
  /** the issuer's x-only key, hex */
  issuer: string
  /** every state from genesis to the current one, hex */
  states: string[]
  /** the issuer's signature on states[0], hex */
  genesis: string
  /** receipts[i] vouches for the move from states[i] to states[i + 1], hex */
  receipts: string[]
}

export const buildConsignment = (
  mint: string,
  issuer: Uint8Array,
  states: CardState[],
  genesis: Uint8Array,
  receipts: Uint8Array[]
): Consignment => ({
  v: 0,
  mint,
  issuer: bytesToHex(issuer),
  states: states.map(state => bytesToHex(encodeState(state))),
  genesis: bytesToHex(genesis),
  receipts: receipts.map(bytesToHex)
})

/** A card whose whole history checked out. */
export type Card = {
  consignment: Consignment
  states: CardState[]
  head: CardState
  /** the note the current state locks to */
  q: Uint8Array
  domain: string
}

const HEX = /^(?:[0-9a-f]{2})*$/
const FIELDS = ['v', 'mint', 'issuer', 'states', 'genesis', 'receipts']
/**
 * The most states a consignment may have: far more moves than a card will
 * see, and a bound on what a lookup can make a holder check. A card mint
 * refuses the move that would go past it.
 */
export const MAX_STATES = 10_000

const hexList = (value: unknown): string[] | null =>
  Array.isArray(value) &&
  value.every(item => typeof item === 'string' && HEX.test(item))
    ? value
    : null

const signature = (value: unknown): Uint8Array | null =>
  typeof value === 'string' && /^[0-9a-f]{128}$/.test(value)
    ? hexToBytes(value)
    : null

/**
 * Checks a consignment offline against the issuer a holder trusts: every
 * state, the genesis signature and every receipt. Whether the head is
 * still live is the card mint's to say (`?p=`). A string says what failed.
 */
export const verifyConsignment = (
  value: unknown,
  issuer: Uint8Array
): Card | string => {
  const record = value as Record<string, unknown>
  if (typeof record !== 'object' || record === null || Array.isArray(record))
    return 'not a consignment'
  const keys = Object.keys(record)
  if (keys.length !== FIELDS.length || !FIELDS.every(key => keys.includes(key)))
    return 'not a consignment'
  if (record.v !== 0) return 'an unknown consignment version'
  if (typeof record.mint !== 'string' || !isAllowedServiceUrl(record.mint))
    return 'no mint it could live at'
  if (record.issuer !== bytesToHex(issuer)) return 'another issuer'
  const encoded = hexList(record.states)
  const receipts = hexList(record.receipts)?.map(signature)
  const genesis = signature(record.genesis)
  if (!encoded?.length || encoded.length > MAX_STATES || !receipts || !genesis)
    return 'not a consignment'
  if (receipts.length !== encoded.length - 1 || receipts.some(r => !r))
    return 'one receipt per move'
  const states: CardState[] = []
  for (const hex of encoded) {
    const state = decodeState(hexToBytes(hex))
    if (!state) return 'a state that does not decode'
    states.push(state)
  }
  const domain = spendDomain(record.mint)
  const [first] = states
  if (first.index !== 0 || !equalBytes(first.prev, ZERO32))
    return 'it does not start at a genesis'
  if (
    !equalBytes(
      first.assetId,
      cardAssetId(issuer, first.name, first.description)
    )
  )
    return 'the card id is not the issuer’s'
  if (!verifies(genesis, genesisDigest(first, domain), issuer))
    return 'the issuer did not sign its genesis'
  for (let i = 1; i < states.length; i++) {
    const problem = moveProblem(states[i - 1], states[i])
    if (problem) return `move ${i}: ${problem}`
    if (
      !verifies(
        receipts[i - 1]!,
        moveDigest(states[i - 1], states[i], domain),
        issuer
      )
    )
      return `move ${i} has no receipt from the mint`
  }
  const head = states[states.length - 1]
  if (!isPointX(head.owner)) return 'the owner is not a key'
  return {
    consignment: record as Consignment,
    states,
    head,
    q: cardNote(head).q,
    domain
  }
}

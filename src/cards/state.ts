// LNURLcash cards (docs/CARDS-LNURLCASH.md): a card is one seal, the state
// format of dni's seals addon (lnurl-wallet src/addons/seals/seals.ts, state
// v0), on a LUD-25 script-path note. This file is the state itself: its
// bytes, its hash, its leaf and the note key it locks to.
import {
  concatBytes,
  equalBytes,
  readU16be,
  readU32be,
  sha256,
  taggedHash,
  u16be,
  u32be,
  utf8ToBytes
} from '../spec/bytes.ts'
import {isPointX} from '../spec/encoding.ts'
import {leafNote, type LeafNote} from '../spec/notes.ts'
import {OP, compileScript} from '../spec/script.ts'

export const STATE_TAG = utf8ToBytes('LNURLcash/seal/state/v0')
/** Bitcoin Core refuses a witness item over 520 bytes, and the state is one. */
export const MAX_STATE_BYTES = 520
export const ZERO32 = new Uint8Array(32)

export type CardState = {
  /** 32 bytes, fixed at genesis */
  assetId: Uint8Array
  /** a card's id in its collection, e.g. E1-042; fixed at genesis */
  name: string
  /** `<collection_id>#<serial>`, e.g. 600B-E1#17; fixed at genesis */
  description: string
  /** 0 at genesis, one more on every move */
  index: number
  /** the holder's x-only key */
  owner: Uint8Array
  /** sha256 of the state before, zero at genesis */
  prev: Uint8Array
}

const lengthPrefixed = (text: string): Uint8Array => {
  const bytes = utf8ToBytes(text)
  return concatBytes(u16be(bytes.length), bytes)
}

/** The state's bytes: the preimage the leaf's OP_SHA256 checks. */
export const encodeState = (state: CardState): Uint8Array => {
  const bytes = concatBytes(
    STATE_TAG,
    state.assetId,
    lengthPrefixed(state.name),
    lengthPrefixed(state.description),
    u32be(state.index),
    state.owner,
    state.prev
  )
  if (bytes.length > MAX_STATE_BYTES)
    throw new Error('A card state over 520 bytes could never move.')
  return bytes
}

const utf8 = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})

/** Strict: exactly one encoding per state, a real owner key, at most 520 bytes. */
export const decodeState = (bytes: Uint8Array): CardState | null => {
  if (bytes.length > MAX_STATE_BYTES) return null
  if (!equalBytes(bytes.slice(0, STATE_TAG.length), STATE_TAG)) return null
  let at = STATE_TAG.length
  const take = (length: number): Uint8Array | null => {
    if (at + length > bytes.length) return null
    const part = bytes.slice(at, at + length)
    at += length
    return part
  }
  const text = (): string | null => {
    const size = take(2)
    const body = size && take(readU16be(size, 0))
    try {
      return body ? utf8.decode(body) : null
    } catch {
      return null
    }
  }
  const assetId = take(32)
  const name = text()
  const description = text()
  const index = take(4)
  const owner = take(32)
  const prev = take(32)
  if (!assetId || name === null || description === null || !index) return null
  if (!owner || !prev || at !== bytes.length || !isPointX(owner)) return null
  const state = {
    assetId,
    name,
    description,
    index: readU32be(index, 0),
    owner,
    prev
  }
  return equalBytes(encodeState(state), bytes) ? state : null
}

export const stateHash = (state: CardState): Uint8Array =>
  sha256(encodeState(state))

/** `OP_SHA256 <sha256(state)> OP_EQUALVERIFY <owner> OP_CHECKSIG` */
export const cardLeaf = (state: CardState): Uint8Array =>
  compileScript([
    OP.SHA256,
    stateHash(state),
    OP.EQUALVERIFY,
    state.owner,
    OP.CHECKSIG
  ])

/** The note a state locks to: the leaf alone under NUMS H. */
export const cardNote = (state: CardState): LeafNote =>
  leafNote(cardLeaf(state))

/** Every card of one issuer has its own id: issuer, card and serial. */
export const cardAssetId = (
  issuer: Uint8Array,
  name: string,
  description: string
): Uint8Array =>
  taggedHash(
    'LNURLcash/card/asset/v0',
    issuer,
    lengthPrefixed(name),
    lengthPrefixed(description)
  )

export const genesisState = (
  issuer: Uint8Array,
  name: string,
  description: string,
  owner: Uint8Array
): CardState => ({
  assetId: cardAssetId(issuer, name, description),
  name,
  description,
  index: 0,
  owner,
  prev: ZERO32
})

/** The state a move to `owner` leads to. */
export const nextState = (state: CardState, owner: Uint8Array): CardState => ({
  assetId: state.assetId,
  name: state.name,
  description: state.description,
  index: state.index + 1,
  owner,
  prev: stateHash(state)
})

/** Why `next` is not the state after `prev`, or null if it is. */
export const moveProblem = (
  prev: CardState,
  next: CardState
): string | null => {
  if (
    !equalBytes(prev.assetId, next.assetId) ||
    prev.name !== next.name ||
    prev.description !== next.description
  )
    return 'a card keeps its identity'
  if (next.index !== prev.index + 1) return 'the index goes up by one'
  if (!equalBytes(next.prev, stateHash(prev)))
    return 'it does not chain to the state before'
  if (!isPointX(next.owner)) return 'the owner is not a key'
  return null
}

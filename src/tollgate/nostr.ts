// NIP-01 events, as far as TollGate uses them: an advertisement, a session
// and a notice are Nostr events signed by the TollGate's own key.
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, sha256, utf8ToBytes} from '../spec/bytes.ts'

export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** NIP-01: sha256 of [0, pubkey, created_at, kind, tags, content]. */
export const eventId = (event: Omit<NostrEvent, 'id' | 'sig'>): string =>
  bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([
          0,
          event.pubkey,
          event.created_at,
          event.kind,
          event.tags,
          event.content
        ])
      )
    )
  )

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/** A well-formed event whose id and signature check out. */
export const isValidEvent = (value: unknown): value is NostrEvent => {
  const event = value as NostrEvent
  if (
    typeof event !== 'object' ||
    event === null ||
    typeof event.pubkey !== 'string' ||
    !HEX64.test(event.pubkey) ||
    typeof event.id !== 'string' ||
    !HEX64.test(event.id) ||
    typeof event.sig !== 'string' ||
    !HEX128.test(event.sig) ||
    !Number.isSafeInteger(event.created_at) ||
    !Number.isSafeInteger(event.kind) ||
    typeof event.content !== 'string' ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      tag => Array.isArray(tag) && tag.every(item => typeof item === 'string')
    )
  )
    return false
  if (eventId(event) !== event.id) return false
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    )
  } catch {
    return false
  }
}

/** Signs an event: the TollGate's side, for the reference TollGate in tests. */
export const signEvent = (
  secretKey: Uint8Array,
  event: Omit<NostrEvent, 'id' | 'sig' | 'pubkey'>
): NostrEvent => {
  const unsigned = {
    ...event,
    pubkey: bytesToHex(schnorr.getPublicKey(secretKey))
  }
  const id = eventId(unsigned)
  return {
    ...unsigned,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), secretKey))
  }
}

/** The first tag with this name, as its values after the name. */
export const tagValues = (
  event: NostrEvent,
  name: string
): string[] | undefined => event.tags.find(tag => tag[0] === name)?.slice(1)

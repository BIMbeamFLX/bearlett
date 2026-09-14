import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'
import {WalletUnreadable} from './wallets'
import type {Codec} from './wallets'

/**
 * An account wallet, sealed at rest.
 *
 * The card library keeps its mnemonic, private key and every card token in
 * one JSON state, and the shell stores whatever the napplet gives it. For an
 * account wallet that state is sealed with AES-256-GCM, the cipher the sats
 * wallet uses, under a key derived from the account seed with HKDF-SHA256 and
 * a label of its own: never the seed itself, and useless for anything but this
 * storage. Each value is also bound to the key it is stored under, so a sealed
 * wallet copied onto another key does not open there.
 *
 * The random-mnemonic wallet has no seed from outside and no password to
 * derive from, so it stays as the library writes it. docs/NAPPLETS.md states
 * that residual risk rather than inventing a password prompt.
 */

const SALT = utf8ToBytes('bearlett:nutft:storage')
const INFO = utf8ToBytes('account wallet, AES-256-GCM, v1')
const BOUND_TO = 'bearlett:nutft:sealed:v1|'

type Envelope = {v: 1; alg: 'A256GCM'; iv: string; data: string}

const isEnvelope = (value: unknown): value is Envelope => {
  const record = value as Record<string, unknown> | null
  return (
    typeof record === 'object' &&
    record !== null &&
    record.v === 1 &&
    record.alg === 'A256GCM' &&
    typeof record.iv === 'string' &&
    /^[0-9a-f]{24}$/.test(record.iv) &&
    typeof record.data === 'string' &&
    record.data.length >= 32 &&
    /^(?:[0-9a-f]{2})+$/.test(record.data)
  )
}

/** The storage key material for one account. Exported for the tests. */
export const storageKeyMaterial = (seed: string): Uint8Array => {
  if (!isHostSeed(seed)) throw new UnsafeLease()
  return hkdf(sha256, hexToBytes(seed), SALT, INFO, 32)
}

export function sealedWith(seed: string): Codec {
  const derived = storageKeyMaterial(seed)
  const material = new Uint8Array(derived)
  derived.fill(0)
  const key = globalThis.crypto.subtle.importKey(
    'raw',
    material,
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  )
  /* The key is not extractable once imported; the bytes are not kept. */
  const forget = () => material.fill(0)
  key.then(forget, forget)
  const bound = (where: string) => utf8ToBytes(BOUND_TO + where)

  return {
    seal: async (value, where) => {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const data = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          {name: 'AES-GCM', iv, additionalData: bound(where)},
          await key,
          utf8ToBytes(value)
        )
      )
      return JSON.stringify({
        v: 1,
        alg: 'A256GCM',
        iv: bytesToHex(iv),
        data: bytesToHex(data)
      } satisfies Envelope)
    },
    open: async (stored, where) => {
      let envelope: unknown
      try {
        envelope = JSON.parse(stored)
      } catch {
        throw new WalletUnreadable()
      }
      /* A value that is not sealed at a key that must be is refused, not
         read: nothing here writes an account wallet in the clear. */
      if (!isEnvelope(envelope)) throw new WalletUnreadable()
      try {
        const plain = await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: hexToBytes(envelope.iv),
            additionalData: bound(where)
          },
          await key,
          hexToBytes(envelope.data)
        )
        return new TextDecoder().decode(plain)
      } catch {
        throw new WalletUnreadable()
      }
    }
  }
}

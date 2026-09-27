// Byte helpers shared by the LUD-25 core. Everything here is plain data
// shuffling; the protocol meaning lives in the modules that import it.
import {sha256} from '@noble/hashes/sha2.js'
import {hmac} from '@noble/hashes/hmac.js'
import {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
  randomBytes
} from '@noble/hashes/utils.js'
import {
  bytesToNumberBE,
  numberToBytesBE,
  equalBytes
} from '@noble/curves/utils.js'
import {schnorr} from '@noble/curves/secp256k1.js'

export {
  sha256,
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
  randomBytes,
  bytesToNumberBE,
  numberToBytesBE,
  equalBytes
}

/** BIP-340 tagged hash: sha256(sha256(tag) || sha256(tag) || parts). */
export const taggedHash = (tag: string, ...parts: Uint8Array[]): Uint8Array =>
  schnorr.utils.taggedHash(tag, ...parts)

export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array =>
  hmac(sha256, key, message)

const uint = (bytes: number, value: number, littleEndian: boolean) => {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * bytes))
    throw new Error(`Not a ${8 * bytes}-bit unsigned integer: ${value}`)
  const out = new Uint8Array(bytes)
  const view = new DataView(out.buffer)
  if (bytes === 2) view.setUint16(0, value, littleEndian)
  else view.setUint32(0, value, littleEndian)
  return out
}

export const u16be = (value: number): Uint8Array => uint(2, value, false)
export const u32be = (value: number): Uint8Array => uint(4, value, false)
export const u32le = (value: number): Uint8Array => uint(4, value, true)

export const u64le = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

export const readU16be = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, false)

export const readU32be = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, false)

/** Exactly 64 hex characters: LUD-25's short forms (Notes, Short forms). */
export const isHex64 = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value)

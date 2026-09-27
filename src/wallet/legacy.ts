// One-time import of notes made by the Bearlett before the rebuild
// (2026-09-20 to 2026-09-27, @lnurlcash/kit 0.18-0.19). Two ladders hung off
// the same per-mint branch as today's keys:
//
//   bearer preimages  hex(branch / i')                    hardened children
//   key-path keys     t = tagged_hash("LNURLcash/derive", P || chaincode || ser32(i))
//                     the tweak before LUD-25 added `purpose`
//
// Bearer notes still open with their preimage (the k1 short form). Key-path
// notes were signed over sha256("LNURLcash"), which mints no longer accept,
// so they are re-signed for the key-path sighash. Everything found is
// rotated into today's keys. Delete this file once no one needs it.
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToHex,
  bytesToNumberBE,
  numberToBytesBE,
  sha256,
  taggedHash,
  u32be
} from '../spec/bytes.ts'
import {CURVE_ORDER} from '../spec/taproot.ts'
import {bearerNote, signKeySpend} from '../spec/notes.ts'

const HARDENED = 0x80000000

export type LegacyNote = {q: string; k1: string; spend: 'preimage' | 'key'}

/** The old bearer ladder's secret at `index`. */
export const legacyPreimage = (branch: HDKey, index: number): Uint8Array => {
  const key = branch.deriveChild(index + HARDENED).privateKey
  if (!key) throw new Error('Not a private branch.')
  return key
}

/** The old key ladder's secret key at `index` (no purpose in the tweak). */
export const legacySecretKey = (branch: HDKey, index: number): Uint8Array => {
  if (!branch.privateKey || !branch.publicKey)
    throw new Error('Not a private branch.')
  const t =
    bytesToNumberBE(
      taggedHash(
        'LNURLcash/derive',
        branch.publicKey.slice(1),
        branch.chainCode!,
        u32be(index)
      )
    ) % CURVE_ORDER
  const p = bytesToNumberBE(branch.privateKey)
  const oddY = branch.publicKey[0] === 0x03
  return numberToBytesBE(((oddY ? CURVE_ORDER - p : p) + t) % CURVE_ORDER, 32)
}

/** What index `index` of either ladder names at a mint, and how to open it. */
export const legacyCandidates = (
  branch: HDKey,
  domain: string,
  index: number
): LegacyNote[] => {
  const preimage = legacyPreimage(branch, index)
  const secretKey = legacySecretKey(branch, index)
  return [
    {
      q: bytesToHex(bearerNote(sha256(preimage)).q),
      k1: bytesToHex(preimage),
      spend: 'preimage'
    },
    {
      q: bytesToHex(schnorr.getPublicKey(secretKey)),
      k1: signKeySpend(secretKey, domain),
      spend: 'key'
    }
  ]
}

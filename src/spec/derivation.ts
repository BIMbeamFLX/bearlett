// LUD-25 "Seed & derivation": one hardened branch per SERVICE, reached with
// LUD-05's domain hashing under its own purpose m/139', and note keys
// tweaked off that branch non-hardened, split into three purposes.
import {HDKey} from '@scure/bip32'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToNumberBE,
  hmacSha256,
  numberToBytesBE,
  readU32be,
  sha256,
  taggedHash,
  u32be,
  utf8ToBytes
} from './bytes.ts'
import {CURVE_ORDER, liftX} from './taproot.ts'
import type {BranchExport} from './encoding.ts'

const HARDENED = 0x80000000

/** Which of a branch's three independent counters a key belongs to. */
export const PURPOSE = {
  /** every note WALLET mints, rotates or merges into, and a split's p1 */
  wallet: 0,
  /** a split's change note p2 */
  change: 1,
  /** a note credited by Lightning Address auto-mint or internal transfer */
  lightningAddress: 2
} as const

export type Purpose = (typeof PURPOSE)[keyof typeof PURPOSE]
export const PURPOSES: Purpose[] = [0, 1, 2]

/** m/139': LUD-25's own purpose, so it never shares keys with LUD-05. */
export const cashRoot = (master: HDKey): HDKey =>
  master.deriveChild(139 + HARDENED)

/** (d1, d2, d3, d4): LUD-05 steps 1-3 under m/139'/0, as big-endian uint32. */
export const domainPath = (root: HDKey, domain: string): number[] => {
  const hashingKey = root.deriveChild(0).privateKey
  if (!hashingKey) throw new Error('The cash root has no private key.')
  const material = hmacSha256(hashingKey, utf8ToBytes(domain))
  return [0, 4, 8, 12].map(offset => readU32be(material, offset))
}

/** This SERVICE's branch root, m/139'/d1/d2/d3/d4. */
export const branchNode = (root: HDKey, domain: string): HDKey =>
  domainPath(root, domain).reduce(
    (node, index) => node.deriveChild(index),
    root
  )

/** P (x-only) and chain code: everything needed to enumerate the branch. */
export const branchExport = (node: HDKey): BranchExport => {
  if (!node.publicKey || !node.chainCode) throw new Error('Not a branch node.')
  return {p: node.publicKey.slice(1), chainCode: node.chainCode}
}

const tweak = (
  branch: BranchExport,
  purpose: number,
  index: number
): bigint => {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32)
    throw new Error(`Bad note index ${index}.`)
  const hash = taggedHash(
    'LNURLcash/derive',
    branch.p,
    branch.chainCode,
    u32be(purpose),
    u32be(index)
  )
  return bytesToNumberBE(hash) % CURVE_ORDER
}

/** pk_i = x(lift_x(P) + t·G): computable from the branch export alone. */
export const notePubkey = (
  branch: BranchExport,
  purpose: number,
  index: number
): Uint8Array => {
  const point = liftX(branch.p).add(
    schnorr.Point.BASE.multiply(tweak(branch, purpose, index))
  )
  return schnorr.utils.pointToBytes(point)
}

/** sk_i = p + t, or (n - p) + t when P has odd y (BIP-341's parity rule). */
export const noteSecretKey = (
  node: HDKey,
  purpose: number,
  index: number
): Uint8Array => {
  if (!node.privateKey || !node.publicKey)
    throw new Error('Not a private branch.')
  const p = bytesToNumberBE(node.privateKey)
  const oddY = node.publicKey[0] === 0x03
  const t = tweak(branchExport(node), purpose, index)
  const sk = ((oddY ? CURVE_ORDER - p : p) + t) % CURVE_ORDER
  if (sk === 0n) throw new Error('Derived a zero key; skip this index.')
  return numberToBytesBE(sk, 32)
}

/** BIP-340 aux_rand for every signature a wallet should be able to redo. */
export const ZERO_AUX = new Uint8Array(32)

export type AddressAction = 'register' | 'unregister'

/** sha256("LNURLcash:register:" || domain || ":" || username). */
export const addressProofDigest = (
  action: AddressAction,
  domain: string,
  username: string
): Uint8Array =>
  sha256(utf8ToBytes(`LNURLcash:${action}:${domain}:${username}`))

/**
 * The Lightning Address registration proof: a Schnorr signature by the
 * branch's purpose-0 index-0 key (Lightning Address auto-mint).
 */
export const signAddressProof = (
  node: HDKey,
  action: AddressAction,
  domain: string,
  username: string
): Uint8Array =>
  schnorr.sign(
    addressProofDigest(action, domain, username),
    noteSecretKey(node, PURPOSE.wallet, 0),
    ZERO_AUX
  )

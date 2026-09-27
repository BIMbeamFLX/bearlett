// LUD-25 "Notes": a note is a taproot output key Q; a spend opens it by key
// path (ck1), by script path (cw1), or, for a bearer note, by its preimage
// in hex (the k1 short form).
import {schnorr} from '@noble/curves/secp256k1.js'
import {hexToBytes, isHex64, randomBytes, sha256} from './bytes.ts'
import {
  decodeCk1,
  decodeCp1,
  decodeCw1,
  encodeCk1,
  encodeCw1
} from './encoding.ts'
import {OP, compileScript, hasSuccessOpcode, scriptNum} from './script.ts'
import {
  LEAF_VERSION,
  NUMS_H,
  buildControlBlock,
  parseControlBlock,
  scriptPathOutputKey,
  tapleafHash,
  tweakOutputKey
} from './taproot.ts'
import {KEY_PATH_CLAIM, spendSighash, type TimeClaim} from './spend.ts'
import {evaluateLeaf, type ScriptResult} from './interpreter.ts'
import {ZERO_AUX} from './derivation.ts'

// ---- script notes: one leaf under NUMS, so no key path ----

export type LeafNote = {q: Uint8Array; leaf: Uint8Array; control: Uint8Array}

export const leafNote = (leaf: Uint8Array): LeafNote => {
  const {q, parity} = tweakOutputKey(NUMS_H, tapleafHash(leaf))
  const control = buildControlBlock({
    leafVersion: LEAF_VERSION,
    parity,
    internalX: NUMS_H,
    path: []
  })
  return {q, leaf, control}
}

/** A spend of a single-leaf note: witness items bottom of stack first. */
export const leafSpend = (
  note: LeafNote,
  witness: Uint8Array[],
  claim: TimeClaim = KEY_PATH_CLAIM
): string =>
  encodeCw1({
    locktime: claim.locktime,
    sequence: claim.sequence,
    script: note.leaf,
    control: note.control,
    witness
  })

// ---- bearer notes (Bearer notes) ----

export const bearerLeaf = (h: Uint8Array): Uint8Array =>
  compileScript([OP.SHA256, h, OP.EQUAL])

export const bearerNote = (h: Uint8Array): LeafNote => leafNote(bearerLeaf(h))

export const newPreimage = (): Uint8Array => randomBytes(32)

/** The full cw1 of a bearer note; its hex preimage is the short form. */
export const bearerCw1 = (preimage: Uint8Array): string =>
  leafSpend(bearerNote(sha256(preimage)), [preimage])

// ---- key-path notes (Key-path notes) ----

/** ck1: Q = x(sk·G) signs the key-path sighash for `domain`, aux_rand zero. */
export const signKeySpend = (secretKey: Uint8Array, domain: string): string => {
  const q = schnorr.getPublicKey(secretKey)
  const sig = schnorr.sign(
    spendSighash(q, domain, KEY_PATH_CLAIM),
    secretKey,
    ZERO_AUX
  )
  return encodeCk1(q, sig)
}

// ---- timelocked notes (Timelocks) ----

export const LOCKTIME_THRESHOLD = 500_000_000

/**
 * `<pk> OP_CHECKSIGVERIFY <T> OP_CHECKLOCKTIMEVERIFY`: `pk` may spend from
 * Unix time T on, by SERVICE's clock (BIP-46 v3's leaf, and/or of
 * pk(K) and after(T)). A custodial policy, never a trustless lock.
 */
export const timelockLeaf = (
  pubkey: Uint8Array,
  locktime: number
): Uint8Array => {
  if (
    !Number.isInteger(locktime) ||
    locktime < LOCKTIME_THRESHOLD ||
    locktime >= 2 ** 32
  )
    throw new Error('A timelock is a Unix time.')
  return compileScript([
    pubkey,
    OP.CHECKSIGVERIFY,
    scriptNum(locktime),
    OP.CHECKLOCKTIMEVERIFY
  ])
}

/** Claims `locktime`, with the non-final sequence CHECKLOCKTIMEVERIFY needs. */
export const timelockClaim = (locktime: number): TimeClaim => ({
  locktime,
  sequence: 0xfffffffe
})

/** A leaf spend's BIP-342 signature, aux_rand zero like every other. */
export const signLeaf = (
  note: LeafNote,
  secretKey: Uint8Array,
  domain: string,
  claim: TimeClaim
): Uint8Array =>
  schnorr.sign(
    spendSighash(note.q, domain, claim, tapleafHash(note.leaf)),
    secretKey,
    ZERO_AUX
  )

/** The cw1 that opens a timelocked note once T has passed. */
export const timelockSpend = (
  secretKey: Uint8Array,
  locktime: number,
  domain: string
): string => {
  const note = leafNote(timelockLeaf(schnorr.getPublicKey(secretKey), locktime))
  const claim = timelockClaim(locktime)
  return leafSpend(note, [signLeaf(note, secretKey, domain, claim)], claim)
}

// ---- references and spends ----

/** Q named by a cp1, or by a bearer note's hex h (the cp1 short form). */
export const noteRefQ = (ref: string): Uint8Array | null => {
  const text = ref.trim()
  return isHex64(text) ? bearerNote(hexToBytes(text)).q : decodeCp1(text)
}

export type Spend =
  | {kind: 'preimage'; q: Uint8Array; preimage: Uint8Array}
  | {kind: 'key'; q: Uint8Array; sig: Uint8Array}
  | {
      kind: 'script'
      q: Uint8Array
      claim: TimeClaim
      script: Uint8Array
      control: Uint8Array
      witness: Uint8Array[]
    }

/**
 * Decodes a k1: a bearer note's hex preimage, a ck1 or a cw1. A cw1 whose
 * leaf version is not 0xc0, or that carries an OP_SUCCESSx, or whose control
 * block does not fold to a valid Q, is rejected as SERVICE would reject it.
 */
export const decodeSpend = (k1: string): Spend | null => {
  const text = k1.trim()
  if (isHex64(text)) {
    const preimage = hexToBytes(text)
    return {kind: 'preimage', q: bearerNote(sha256(preimage)).q, preimage}
  }
  const key = decodeCk1(text)
  if (key) return {kind: 'key', q: key.q, sig: key.sig}
  const script = decodeCw1(text)
  if (!script) return null
  const block = parseControlBlock(script.control)
  if (!block || block.leafVersion !== LEAF_VERSION) return null
  if (hasSuccessOpcode(script.script)) return null
  const q = scriptPathOutputKey(script.script, script.control)
  if (!q) return null
  return {
    kind: 'script',
    q,
    claim: {locktime: script.locktime, sequence: script.sequence},
    script: script.script,
    control: script.control,
    witness: script.witness
  }
}

const SEQUENCE_DISABLE = 0x80000000
const SEQUENCE_TYPE_TIME = 0x00400000

/** Timelocks: a time claim SERVICE could ever honour, on SERVICE's clock. */
export const claimProblem = (claim: TimeClaim): string | null => {
  if (claim.locktime !== 0 && claim.locktime < LOCKTIME_THRESHOLD)
    return 'a non-zero locktime must be a Unix time'
  if (
    !(claim.sequence & SEQUENCE_DISABLE) &&
    !(claim.sequence & SEQUENCE_TYPE_TIME)
  )
    return 'a relative lock must be time-based'
  return null
}

/**
 * Offline verification step 2: whether the spend opens its Q at `domain`,
 * as SERVICE would check it, leaving the time claim to SERVICE's clock.
 */
export const checkSpend = (spend: Spend, domain: string): ScriptResult => {
  if (spend.kind === 'preimage') return {status: 'valid'}
  if (spend.kind === 'key') {
    const sighash = spendSighash(spend.q, domain, KEY_PATH_CLAIM)
    return schnorr.verify(spend.sig, sighash, spend.q)
      ? {status: 'valid'}
      : {status: 'invalid', reason: 'the ck1 signature is for another mint'}
  }
  const problem = claimProblem(spend.claim)
  if (problem) return {status: 'invalid', reason: problem}
  return evaluateLeaf(spend.script, spend.witness, spend.q, domain, spend.claim)
}

// LUD-25 "Encoding": every value the draft introduces is bech32m under its
// own human-readable part, without BIP-173's 90-character limit.
import {bech32m} from '@scure/base'
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToNumberBE,
  concatBytes,
  readU16be,
  readU32be,
  u16be,
  u32be
} from './bytes.ts'

const encode = (hrp: string, data: Uint8Array): string =>
  bech32m.encode(hrp, bech32m.toWords(data), false)

// BIP-173: one case throughout, so a QR code's uppercase form still decodes.
const decode = (value: string): {hrp: string; data: Uint8Array} | null => {
  const text = value.trim()
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null
  try {
    const {prefix, words} = bech32m.decode(text.toLowerCase(), false)
    return {hrp: prefix, data: bech32m.fromWords(words)}
  } catch {
    return null
  }
}

/** Whether 32 bytes are the x coordinate of a curve point (lift_x succeeds). */
export const isPointX = (x: Uint8Array): boolean => {
  if (x.length !== 32) return false
  try {
    schnorr.utils.lift_x(bytesToNumberBE(x))
    return true
  } catch {
    return false
  }
}

// ---- cp1: a note's output key Q ----

export const encodeCp1 = (q: Uint8Array): string => {
  if (!isPointX(q)) throw new Error('Q is not a curve point x coordinate.')
  return encode('cp', q)
}

/** Q, or null: SERVICE MUST reject a cp1 that is not a point x coordinate. */
export const decodeCp1 = (value: string): Uint8Array | null => {
  const decoded = decode(value)
  if (!decoded || decoded.hrp !== 'cp' || !isPointX(decoded.data)) return null
  return decoded.data
}

// ---- ck1: a key-path spend, Q (32) || BIP-340 signature (64) ----

export type KeySpendBytes = {q: Uint8Array; sig: Uint8Array}

export const encodeCk1 = (q: Uint8Array, sig: Uint8Array): string => {
  if (q.length !== 32 || sig.length !== 64) throw new Error('Bad ck1 parts.')
  return encode('ck', concatBytes(q, sig))
}

export const decodeCk1 = (value: string): KeySpendBytes | null => {
  const decoded = decode(value)
  if (!decoded || decoded.hrp !== 'ck' || decoded.data.length !== 96)
    return null
  const q = decoded.data.slice(0, 32)
  if (!isPointX(q)) return null
  return {q, sig: decoded.data.slice(32)}
}

// ---- cw1: a script-path spend ----
//   u32 locktime || u32 sequence || (u16 len || item)* over: script,
//   control block, then the witness items bottom of stack first

export type ScriptSpendBytes = {
  locktime: number
  sequence: number
  script: Uint8Array
  control: Uint8Array
  witness: Uint8Array[]
}

export const encodeCw1 = (spend: ScriptSpendBytes): string => {
  const items = [spend.script, spend.control, ...spend.witness]
  const parts = [u32be(spend.locktime), u32be(spend.sequence)]
  for (const item of items) parts.push(u16be(item.length), item)
  return encode('cw', concatBytes(...parts))
}

export const decodeCw1 = (value: string): ScriptSpendBytes | null => {
  const decoded = decode(value)
  if (!decoded || decoded.hrp !== 'cw' || decoded.data.length < 8) return null
  const data = decoded.data
  const items: Uint8Array[] = []
  let offset = 8
  // the length prefixes must consume the payload exactly
  while (offset < data.length) {
    if (offset + 2 > data.length) return null
    const length = readU16be(data, offset)
    offset += 2
    if (offset + length > data.length) return null
    items.push(data.slice(offset, offset + length))
    offset += length
  }
  if (items.length < 2) return null
  const [script, control, ...witness] = items
  return {
    locktime: readU32be(data, 0),
    sequence: readU32be(data, 4),
    script,
    control,
    witness
  }
}

// ---- cx1: a watch-only branch export, P (32, x-only) || chain code (32) ----

export type BranchExport = {p: Uint8Array; chainCode: Uint8Array}

export const encodeCx1 = (branch: BranchExport): string =>
  encode('cx', concatBytes(branch.p, branch.chainCode))

export const decodeCx1 = (value: string): BranchExport | null => {
  const decoded = decode(value)
  if (!decoded || decoded.hrp !== 'cx' || decoded.data.length !== 64)
    return null
  const p = decoded.data.slice(0, 32)
  if (!isPointX(p)) return null
  return {p, chainCode: decoded.data.slice(32)}
}

// ---- cs1: SERVICE's certificate, amount in the HRP the BOLT-11 way ----

// msat per unit of each BOLT-11 multiplier, largest first; 'p' (0.1 msat)
// is handled on its own
const MULTIPLIERS: [string, bigint][] = [
  ['', 100_000_000_000n],
  ['m', 100_000_000n],
  ['u', 100_000n],
  ['n', 100n]
]

/** The HRP amount for `amountMsat`, in the largest unit that fits exactly. */
export const encodeAmount = (amountMsat: number): string => {
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0)
    throw new Error('A certificate amount is a positive msat integer.')
  const msat = BigInt(amountMsat)
  for (const [suffix, unit] of MULTIPLIERS) {
    if (msat % unit === 0n) return `${msat / unit}${suffix}`
  }
  return `${msat * 10n}p`
}

/** msat for a BOLT-11 amount and multiplier, per BOLT-11's reader rules. */
export const decodeAmount = (text: string): number | null => {
  const match = /^([0-9]+)([munp]?)$/.exec(text)
  if (!match) return null
  const digits = BigInt(match[1])
  let msat: bigint
  if (match[2] === 'p') {
    // pico-bitcoin is a tenth of a msat: the last digit must be 0
    if (digits % 10n !== 0n) return null
    msat = digits / 10n
  } else {
    msat = digits * MULTIPLIERS.find(([suffix]) => suffix === match[2])![1]
  }
  if (msat <= 0n || msat > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(msat)
}

export type Certificate = {amountMsat: number; signature: Uint8Array}

/** signature is r (32) || s (32) || recovery id (1). */
export const encodeCs1 = (
  amountMsat: number,
  signature: Uint8Array
): string => {
  if (signature.length !== 65) throw new Error('A cs1 signature is 65 bytes.')
  return encode(`cs${encodeAmount(amountMsat)}`, signature)
}

export const decodeCs1 = (value: string): Certificate | null => {
  const decoded = decode(value)
  if (!decoded || !decoded.hrp.startsWith('cs')) return null
  const amountMsat = decodeAmount(decoded.hrp.slice(2))
  if (amountMsat === null || decoded.data.length !== 65) return null
  return {amountMsat, signature: decoded.data}
}

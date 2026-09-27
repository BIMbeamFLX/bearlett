// BIP-341 taproot pieces LUD-25 builds every note from (Notes, Output keys
// and spends): leaf and branch hashes, the output-key tweak, control blocks.
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToNumberBE, concatBytes, hexToBytes, taggedHash} from './bytes.ts'
import {isPointX} from './encoding.ts'

const {Point} = schnorr
export const CURVE_ORDER = Point.CURVE().n

/** BIP-341's nothing-up-my-sleeve point H: a note with no key path. */
export const NUMS_H = hexToBytes(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0'
)

/** The only leaf version LUD-25 accepts (Output keys and spends). */
export const LEAF_VERSION = 0xc0

export const liftX = (x: Uint8Array) => schnorr.utils.lift_x(bytesToNumberBE(x))

export const compactSize = (n: number): Uint8Array => {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  return Uint8Array.of(
    0xfe,
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    n >>> 24
  )
}

export const tapleafHash = (
  script: Uint8Array,
  leafVersion: number = LEAF_VERSION
): Uint8Array =>
  taggedHash(
    'TapLeaf',
    Uint8Array.of(leafVersion),
    compactSize(script.length),
    script
  )

const compare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export const tapbranchHash = (a: Uint8Array, b: Uint8Array): Uint8Array =>
  compare(a, b) <= 0
    ? taggedHash('TapBranch', a, b)
    : taggedHash('TapBranch', b, a)

export type OutputKey = {q: Uint8Array; parity: 0 | 1}

/** Q = lift_x(internal) + hash_TapTweak(internal || merkle root)·G. */
export const tweakOutputKey = (
  internalX: Uint8Array,
  merkleRoot: Uint8Array
): OutputKey => {
  const t = bytesToNumberBE(taggedHash('TapTweak', internalX, merkleRoot))
  if (t >= CURVE_ORDER) throw new Error('Taproot tweak out of range.')
  const point = liftX(internalX).add(Point.BASE.multiply(t))
  return {q: schnorr.utils.pointToBytes(point), parity: point.y & 1n ? 1 : 0}
}

export type ControlBlock = {
  leafVersion: number
  parity: 0 | 1
  internalX: Uint8Array
  path: Uint8Array[]
}

export const buildControlBlock = (block: ControlBlock): Uint8Array =>
  concatBytes(
    Uint8Array.of(block.leafVersion | block.parity),
    block.internalX,
    ...block.path
  )

export const parseControlBlock = (control: Uint8Array): ControlBlock | null => {
  const depth = (control.length - 33) / 32
  if (control.length < 33 || !Number.isInteger(depth) || depth > 128)
    return null
  const internalX = control.slice(1, 33)
  if (!isPointX(internalX)) return null
  const path: Uint8Array[] = []
  for (let i = 0; i < depth; i++)
    path.push(control.slice(33 + 32 * i, 65 + 32 * i))
  return {
    leafVersion: control[0] & 0xfe,
    parity: (control[0] & 1) as 0 | 1,
    internalX,
    path
  }
}

/**
 * The Q a script-path spend opens: the leaf folded up the control block's
 * path and tweaked into its internal key (BIP-341). Null when the control
 * block is malformed or its parity bit does not match Q.
 */
export const scriptPathOutputKey = (
  script: Uint8Array,
  control: Uint8Array
): Uint8Array | null => {
  const block = parseControlBlock(control)
  if (!block) return null
  let node = tapleafHash(script, block.leafVersion)
  for (const sibling of block.path) node = tapbranchHash(node, sibling)
  const {q, parity} = tweakOutputKey(block.internalX, node)
  return parity === block.parity ? q : null
}

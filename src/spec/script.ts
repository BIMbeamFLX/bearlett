// The slice of Bitcoin script a wallet needs to build and read tapscript
// leaves: minimal pushes, script numbers, decompiling, and BIP-342's
// OP_SUCCESSx scan (LUD-25, Output keys and spends: SERVICE MUST reject a
// leaf containing one outside pushed data).
import {concatBytes} from './bytes.ts'

export const OP = {
  0: 0x00,
  PUSHDATA1: 0x4c,
  PUSHDATA2: 0x4d,
  PUSHDATA4: 0x4e,
  '1NEGATE': 0x4f,
  1: 0x51,
  16: 0x60,
  IF: 0x63,
  NOTIF: 0x64,
  ELSE: 0x67,
  ENDIF: 0x68,
  VERIFY: 0x69,
  DROP: 0x75,
  DUP: 0x76,
  EQUAL: 0x87,
  EQUALVERIFY: 0x88,
  NUMEQUAL: 0x9c,
  SHA256: 0xa8,
  CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad,
  CHECKLOCKTIMEVERIFY: 0xb1,
  CHECKSEQUENCEVERIFY: 0xb2,
  CHECKSIGADD: 0xba
} as const

/** An opcode, or the data one push puts on the stack. */
export type ScriptItem = number | Uint8Array

/** CScriptNum: little-endian, sign in the top bit, minimal. */
export const scriptNum = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value)) throw new Error('Not a script number.')
  if (value === 0) return new Uint8Array(0)
  const negative = value < 0
  let rest = Math.abs(value)
  const out: number[] = []
  while (rest > 0) {
    out.push(rest & 0xff)
    rest = Math.floor(rest / 256)
  }
  if (out[out.length - 1] & 0x80) out.push(negative ? 0x80 : 0)
  else if (negative) out[out.length - 1] |= 0x80
  return Uint8Array.from(out)
}

/** A CScriptNum of at most `maxLength` bytes, minimally encoded; else null. */
export const readScriptNum = (
  bytes: Uint8Array,
  maxLength = 5
): number | null => {
  if (bytes.length > maxLength) return null
  if (bytes.length === 0) return 0
  const last = bytes[bytes.length - 1]
  // minimal: the top byte carries value bits, unless the byte below needs
  // its high bit for magnitude
  if (
    (last & 0x7f) === 0 &&
    (bytes.length === 1 || !(bytes[bytes.length - 2] & 0x80))
  )
    return null
  let value = 0
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = value * 256 + (i === bytes.length - 1 ? bytes[i] & 0x7f : bytes[i])
  }
  return last & 0x80 ? -value : value
}

const push = (data: Uint8Array): Uint8Array => {
  if (data.length === 0) return Uint8Array.of(OP[0])
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16)
    return Uint8Array.of(OP[1] + data[0] - 1)
  if (data.length === 1 && data[0] === 0x81) return Uint8Array.of(OP['1NEGATE'])
  if (data.length <= 75) return concatBytes(Uint8Array.of(data.length), data)
  if (data.length <= 0xff)
    return concatBytes(Uint8Array.of(OP.PUSHDATA1, data.length), data)
  if (data.length <= 0xffff)
    return concatBytes(
      Uint8Array.of(OP.PUSHDATA2, data.length & 0xff, data.length >> 8),
      data
    )
  throw new Error('Push too large for a tapscript leaf.')
}

/** Compiles opcodes and pushes, every push in its minimal form. */
export const compileScript = (items: ScriptItem[]): Uint8Array =>
  concatBytes(
    ...items.map(item =>
      typeof item === 'number' ? Uint8Array.of(item) : push(item)
    )
  )

/** Opcodes and pushed data, or null when a push runs past the end. */
export const decompileScript = (script: Uint8Array): ScriptItem[] | null => {
  const items: ScriptItem[] = []
  let i = 0
  while (i < script.length) {
    const op = script[i++]
    let length = -1
    if (op >= 0x01 && op <= 0x4b) length = op
    else if (op === OP.PUSHDATA1) {
      if (i + 1 > script.length) return null
      length = script[i]
      i += 1
    } else if (op === OP.PUSHDATA2) {
      if (i + 2 > script.length) return null
      length = script[i] | (script[i + 1] << 8)
      i += 2
    } else if (op === OP.PUSHDATA4) {
      if (i + 4 > script.length) return null
      length =
        (script[i] |
          (script[i + 1] << 8) |
          (script[i + 2] << 16) |
          (script[i + 3] << 24)) >>>
        0
      i += 4
    }
    if (length < 0) {
      items.push(op)
      continue
    }
    if (i + length > script.length) return null
    items.push(script.slice(i, i + length))
    i += length
  }
  return items
}

// BIP-342: 80, 98, 126-129, 131-134, 137-138, 141-142, 149-153, 187-254
const isSuccessOpcode = (op: number): boolean =>
  op === 80 ||
  op === 98 ||
  (op >= 126 && op <= 129) ||
  (op >= 131 && op <= 134) ||
  (op >= 137 && op <= 138) ||
  (op >= 141 && op <= 142) ||
  (op >= 149 && op <= 153) ||
  (op >= 187 && op <= 254)

/** Whether a leaf has an OP_SUCCESSx outside pushed data, or cannot decode. */
export const hasSuccessOpcode = (script: Uint8Array): boolean => {
  const items = decompileScript(script)
  if (!items) return true
  return items.some(item => typeof item === 'number' && isSuccessOpcode(item))
}

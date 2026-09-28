// A small tapscript evaluator (BIP-342) for offline checks: LUD-25's
// "Offline verification" step 2 asks a recipient to check that a spend opens
// Q the way SERVICE would, leaving only the time claims to SERVICE's clock.
// It knows the opcodes wallets use for hashlocks, timelocks, signatures,
// multisig and branches; a leaf using anything else is reported as
// unsupported rather than guessed at. SERVICE's own check (Bitcoin Core's
// interpreter) stays the authority.
import {schnorr} from '@noble/curves/secp256k1.js'
import {equalBytes, sha256} from './bytes.ts'
import {OP, decompileScript, readScriptNum, scriptNum} from './script.ts'
import {spendSighash, type TimeClaim} from './spend.ts'
import {tapleafHash} from './taproot.ts'

export type ScriptResult =
  | {status: 'valid'}
  | {status: 'invalid'; reason: string}
  | {status: 'unsupported'; reason: string}

const LOCKTIME_THRESHOLD = 500_000_000
const SEQUENCE_DISABLE = 0x80000000
const SEQUENCE_TYPE_TIME = 0x00400000
const SEQUENCE_MASK = 0x0000ffff

class Fail extends Error {}
class Unsupported extends Error {}

const isTrue = (item: Uint8Array): boolean => {
  for (let i = 0; i < item.length; i++) {
    if (item[i] !== 0) return !(i === item.length - 1 && item[i] === 0x80)
  }
  return false
}

const num = (item: Uint8Array, maxLength = 4): number => {
  const value = readScriptNum(item, maxLength)
  if (value === null) throw new Fail('non-minimal or oversized number')
  return value
}

/**
 * Evaluates `script` over `witness` (bottom of stack first) as input 0 of
 * the canonical spend transaction for `q` at `domain`.
 */
export const evaluateLeaf = (
  script: Uint8Array,
  witness: Uint8Array[],
  q: Uint8Array,
  domain: string,
  claim: TimeClaim
): ScriptResult => {
  const items = decompileScript(script)
  if (!items) return {status: 'invalid', reason: 'the leaf does not decode'}
  // Bitcoin Core checks the initial stack before running a tapscript
  if (witness.length > 1000)
    return {status: 'invalid', reason: 'more than 1000 witness items'}
  if (witness.some(item => item.length > 520))
    return {status: 'invalid', reason: 'a witness item larger than 520 bytes'}
  const leafHash = tapleafHash(script)
  const stack: Uint8Array[] = witness.map(item => item.slice())
  // one entry per open IF: whether its current branch executes
  const branches: boolean[] = []
  const pop = (): Uint8Array => {
    const item = stack.pop()
    if (!item) throw new Fail('stack underflow')
    return item
  }
  const top = (): Uint8Array => {
    if (!stack.length) throw new Fail('stack underflow')
    return stack[stack.length - 1]
  }
  const checkSig = (pubkey: Uint8Array, sig: Uint8Array): boolean => {
    if (pubkey.length === 0) throw new Fail('empty public key')
    if (pubkey.length !== 32)
      throw new Unsupported('a public key of an upgradable type')
    if (sig.length === 0) return false
    if (sig.length !== 64)
      throw new Unsupported('a signature hash type other than the default')
    const sighash = spendSighash(q, domain, claim, leafHash)
    if (!schnorr.verify(sig, sighash, pubkey)) throw new Fail('bad signature')
    return true
  }
  try {
    for (const item of items) {
      const executing = branches.every(Boolean)
      if (item instanceof Uint8Array) {
        if (item.length > 520) throw new Fail('push larger than 520 bytes')
        if (executing) stack.push(item)
        continue
      }
      const op = item
      if (op === OP.IF || op === OP.NOTIF) {
        let taken = false
        if (executing) {
          const condition = pop()
          // MINIMALIF is consensus in tapscript
          if (
            condition.length > 1 ||
            (condition.length === 1 && condition[0] !== 1)
          )
            throw new Fail('non-minimal IF argument')
          taken = (condition.length === 1) === (op === OP.IF)
        }
        branches.push(taken)
        continue
      }
      if (op === OP.ELSE) {
        if (!branches.length) throw new Fail('ELSE without IF')
        branches[branches.length - 1] = !branches[branches.length - 1]
        continue
      }
      if (op === OP.ENDIF) {
        if (!branches.length) throw new Fail('ENDIF without IF')
        branches.pop()
        continue
      }
      if (!executing) continue
      if (op === OP[0]) stack.push(new Uint8Array(0))
      else if (op === OP['1NEGATE']) stack.push(scriptNum(-1))
      else if (op >= OP[1] && op <= OP[16])
        stack.push(scriptNum(op - OP[1] + 1))
      else if (op === OP.VERIFY) {
        if (!isTrue(pop())) throw new Fail('VERIFY failed')
      } else if (op === OP.DROP) pop()
      else if (op === OP.DUP) stack.push(top().slice())
      else if (op === OP.SHA256) stack.push(sha256(pop()))
      else if (op === OP.EQUAL || op === OP.EQUALVERIFY) {
        const equal = equalBytes(pop(), pop())
        if (op === OP.EQUALVERIFY) {
          if (!equal) throw new Fail('EQUALVERIFY failed')
        } else stack.push(equal ? Uint8Array.of(1) : new Uint8Array(0))
      } else if (op === OP.NUMEQUAL) {
        stack.push(
          num(pop()) === num(pop()) ? Uint8Array.of(1) : new Uint8Array(0)
        )
      } else if (op === OP.CHECKSIG || op === OP.CHECKSIGVERIFY) {
        const pubkey = pop()
        const ok = checkSig(pubkey, pop())
        if (op === OP.CHECKSIGVERIFY) {
          if (!ok) throw new Fail('CHECKSIGVERIFY failed')
        } else stack.push(ok ? Uint8Array.of(1) : new Uint8Array(0))
      } else if (op === OP.CHECKSIGADD) {
        const pubkey = pop()
        const n = num(pop())
        stack.push(scriptNum(checkSig(pubkey, pop()) ? n + 1 : n))
      } else if (op === OP.CHECKLOCKTIMEVERIFY) {
        const lock = num(top(), 5)
        if (lock < 0) throw new Fail('negative locktime')
        if (lock < LOCKTIME_THRESHOLD !== claim.locktime < LOCKTIME_THRESHOLD)
          throw new Fail('locktime type mismatch')
        if (claim.locktime < lock) throw new Fail('locktime claim too early')
        if (claim.sequence === 0xffffffff) throw new Fail('final sequence')
      } else if (op === OP.CHECKSEQUENCEVERIFY) {
        const lock = num(top(), 5)
        if (lock < 0) throw new Fail('negative sequence lock')
        if (!(lock & SEQUENCE_DISABLE)) {
          if (claim.sequence & SEQUENCE_DISABLE)
            throw new Fail('sequence lock disabled')
          const mask = SEQUENCE_TYPE_TIME | SEQUENCE_MASK
          const want = lock & mask
          const have = claim.sequence & mask
          if ((want & SEQUENCE_TYPE_TIME) !== (have & SEQUENCE_TYPE_TIME))
            throw new Fail('sequence lock type mismatch')
          if ((have & SEQUENCE_MASK) < (want & SEQUENCE_MASK))
            throw new Fail('sequence claim too early')
        }
      } else {
        throw new Unsupported(`opcode 0x${op.toString(16)}`)
      }
      if (stack.length > 1000) throw new Fail('stack too large')
    }
    if (branches.length) throw new Fail('unbalanced IF')
    if (stack.length !== 1 || !isTrue(stack[0]))
      throw new Fail('the leaf does not leave exactly one true item')
    return {status: 'valid'}
  } catch (err) {
    if (err instanceof Unsupported)
      return {status: 'unsupported', reason: err.message}
    if (err instanceof Fail) return {status: 'invalid', reason: err.message}
    throw err
  }
}

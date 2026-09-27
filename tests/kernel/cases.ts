// Spends built with Bearlett's spec core, each with Bearlett's own verdict,
// written as JSON for judge.py, which has lnurlcash-kernel (Bitcoin Core's
// interpreter, libbitcoinkernel) judge the same spends. CI compares them.
//
//   node tests/kernel/cases.ts > cases.json && python tests/kernel/judge.py cases.json
import {schnorr} from '@noble/curves/secp256k1.js'
import {
  bytesToHex,
  hexToBytes,
  sha256,
  utf8ToBytes
} from '../../src/spec/bytes.ts'
import {
  bearerCw1,
  checkSpend,
  decodeSpend,
  leafNote,
  leafSpend,
  signKeySpend,
  signLeaf,
  timelockClaim,
  timelockLeaf,
  timelockSpend
} from '../../src/spec/notes.ts'
import {OP, compileScript, scriptNum} from '../../src/spec/script.ts'
import {KEY_PATH_CLAIM} from '../../src/spec/spend.ts'
import {
  LEAF_VERSION,
  NUMS_H,
  buildControlBlock,
  tapbranchHash,
  tapleafHash,
  tweakOutputKey
} from '../../src/spec/taproot.ts'

const key = (n: number) => sha256(utf8ToBytes(`bearlett kernel case ${n}`))
const pub = (sk: Uint8Array) => schnorr.getPublicKey(sk)
const DOMAIN = 'mint.example'
const T = 1_800_000_000

type Case = {
  name: string
  k1: string
  q: string
  domain: string
  now: number
  lockedAt: number
  ours: string
}
const cases: Case[] = []
const add = (name: string, k1: string, domain = DOMAIN, now = T + 100) => {
  const spend = decodeSpend(k1)
  if (!spend) throw new Error(`${name}: does not decode`)
  // Bearlett's evaluator leaves the clock to the mint; the kernel case adds it
  const early = spend.kind === 'script' && spend.claim.locktime > now
  cases.push({
    name,
    k1,
    q: bytesToHex(spend.q),
    domain,
    now,
    lockedAt: 0,
    ours: early ? 'time' : checkSpend(spend, domain).status
  })
}

// key path (test vector 3's key)
const v3 = hexToBytes(
  '3616b02290a133da73e758a54dbff1bf6439b4067a820cb51ca873fa4a13a96a'
)
add('ck1 at its domain', signKeySpend(v3, DOMAIN))
add('ck1 at another domain', signKeySpend(v3, DOMAIN), 'other.example')

// bearer note (test vector 5)
const preimage = hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
)
add('bearer cw1', bearerCw1(preimage))
add('bearer k1 short form', bytesToHex(preimage))

// timelock: <pk> CHECKSIGVERIFY <T> CHECKLOCKTIMEVERIFY
const lockKey = key(1)
const lockCw1 = timelockSpend(lockKey, T, DOMAIN)
add('timelock after T', lockCw1)
add('timelock before T', lockCw1, DOMAIN, T - 100)
add('timelock at another domain', lockCw1, 'other.example')
{
  const note = leafNote(timelockLeaf(pub(lockKey), T))
  const claim = {locktime: T, sequence: 0xffffffff}
  add(
    'timelock with a final sequence',
    leafSpend(note, [signLeaf(note, lockKey, DOMAIN, claim)], claim)
  )
}

// a seal leaf: SHA256 <h(state)> EQUALVERIFY <owner> CHECKSIG, witness [sig, state]
{
  const owner = key(2)
  const state = utf8ToBytes('LNURLcash/seal/state/v0 example state')
  const leaf = compileScript([
    OP.SHA256,
    sha256(state),
    OP.EQUALVERIFY,
    pub(owner),
    OP.CHECKSIG
  ])
  const note = leafNote(leaf)
  const claim = {locktime: 0, sequence: 0xfffffffe}
  const sig = signLeaf(note, owner, DOMAIN, claim)
  add('seal leaf', leafSpend(note, [sig, state], claim))
  add(
    'seal leaf, wrong state',
    leafSpend(note, [sig, utf8ToBytes('another state')], claim)
  )
}

// 2-of-2: <A> CHECKSIG <B> CHECKSIGADD 2 NUMEQUAL, witness [sigB, sigA]
{
  const a = key(3)
  const b = key(4)
  const leaf = compileScript([
    pub(a),
    OP.CHECKSIG,
    pub(b),
    OP.CHECKSIGADD,
    scriptNum(2),
    OP.NUMEQUAL
  ])
  const note = leafNote(leaf)
  const sigA = signLeaf(note, a, DOMAIN, KEY_PATH_CLAIM)
  const sigB = signLeaf(note, b, DOMAIN, KEY_PATH_CLAIM)
  add('2-of-2 both signed', leafSpend(note, [sigB, sigA], KEY_PATH_CLAIM))
  add(
    '2-of-2 one signed',
    leafSpend(note, [new Uint8Array(0), sigA], KEY_PATH_CLAIM)
  )
}

// a two-leaf tree: [timelock refund to A after T, B any time]
{
  const a = key(5)
  const b = key(6)
  const refund = timelockLeaf(pub(a), T)
  const direct = compileScript([pub(b), OP.CHECKSIG])
  const hRefund = tapleafHash(refund)
  const hDirect = tapleafHash(direct)
  const {q, parity} = tweakOutputKey(NUMS_H, tapbranchHash(hRefund, hDirect))
  const control = (sibling: Uint8Array) =>
    buildControlBlock({
      leafVersion: LEAF_VERSION,
      parity,
      internalX: NUMS_H,
      path: [sibling]
    })
  const directNote = {q, leaf: direct, control: control(hRefund)}
  add(
    'two-leaf tree, direct leaf',
    leafSpend(
      directNote,
      [signLeaf(directNote, b, DOMAIN, KEY_PATH_CLAIM)],
      KEY_PATH_CLAIM
    )
  )
  const refundNote = {q, leaf: refund, control: control(hDirect)}
  const claim = timelockClaim(T)
  add(
    'two-leaf tree, refund leaf after T',
    leafSpend(refundNote, [signLeaf(refundNote, a, DOMAIN, claim)], claim)
  )
}

process.stdout.write(JSON.stringify(cases, null, 1))

// Spending notes (Output keys and spends, Bearer notes, Key-path notes,
// Timelocks, The canonical spend transaction), against the conformance
// suite's spends.json.
import {describe, expect, it} from 'vitest'
import {vectors} from '../conformance.ts'
import {bytesToHex, hexToBytes, sha256} from '../../src/spec/bytes.ts'
import {decodeCp1, decodeCw1, encodeCp1} from '../../src/spec/encoding.ts'
import {
  bearerCw1,
  bearerNote,
  checkSpend,
  decodeSpend,
  leafProblem,
  noteRefQ,
  signKeySpend,
  timeClaimProblem
} from '../../src/spec/notes.ts'
import {
  mintOutpointTxid,
  spendDomain,
  spendSigMsg,
  spendSighash
} from '../../src/spec/spend.ts'
import {
  scriptPathOutputKey,
  tapleafHash,
  tweakOutputKey
} from '../../src/spec/taproot.ts'
import {schnorr} from '@noble/curves/secp256k1.js'

const v = vectors('spends')

describe('bearer notes', () => {
  it.each(v.bearers.map((b: any) => [b.name, b]))('%s', (_, b: any) => {
    const preimage = hexToBytes(b.preimage)
    const note = bearerNote(sha256(preimage))
    expect(bytesToHex(sha256(preimage))).toBe(b.h)
    expect(bytesToHex(note.leaf)).toBe(b.leaf)
    expect(bytesToHex(tapleafHash(note.leaf))).toBe(b.tapleafHash)
    expect(bytesToHex(note.q)).toBe(b.Q)
    expect(note.control[0] & 1).toBe(b.parity)
    expect(bytesToHex(note.control)).toBe(b.controlBlock)
    expect(encodeCp1(note.q)).toBe(b.cp1)
    expect(bearerCw1(preimage)).toBe(b.cw1)
  })
})

describe('key-path spends', () => {
  const kp = v.keyPath
  const sk = hexToBytes(kp.secretKey)
  const q = hexToBytes(kp.Q)

  it('uses Q as the key itself, with no BIP-86 tweak', () => {
    expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(kp.Q)
    expect(encodeCp1(q)).toBe(kp.cp1)
  })

  it.each(kp.spends.map((s: any) => [s.domain, s]))(
    'signs for %s',
    (_, s: any) => {
      expect(bytesToHex(mintOutpointTxid(s.domain))).toBe(s.prevoutTxid)
      expect(
        bytesToHex(
          spendSighash(q, s.normalisedDomain, {
            locktime: 0,
            sequence: 0xffffffff
          })
        )
      ).toBe(s.sighash)
      expect(signKeySpend(sk, s.normalisedDomain)).toBe(s.ck1)
    }
  )

  it.each(
    kp.crossDomain.map((c: any) => [c.signedFor, c.verifiedAt, c.valid, c])
  )(
    'a ck1 signed for %s, checked at %s: valid %s',
    (signedFor, verifiedAt, valid) => {
      const spend = decodeSpend(signKeySpend(sk, signedFor))!
      expect(checkSpend(spend, verifiedAt).status === 'valid').toBe(valid)
    }
  )
})

describe('the domain a spend is bound to', () => {
  it.each(v.domains.map((d: any) => [d.url, d.domain]))(
    '%s -> %s',
    (url, domain) => {
      expect(spendDomain(url)).toBe(domain)
    }
  )
})

describe('a three-leaf tree with a real internal key', () => {
  const tree = v.tree

  it('tweaks the internal key by the merkle root', () => {
    const {q, parity} = tweakOutputKey(
      hexToBytes(tree.internalKey),
      hexToBytes(tree.merkleRoot)
    )
    expect(bytesToHex(q)).toBe(tree.Q)
    expect(parity).toBe(tree.parity)
    expect(encodeCp1(q)).toBe(tree.cp1)
  })

  it('is spendable by its key path with the tweaked key', () => {
    const ck1 = signKeySpend(
      hexToBytes(tree.keyPath.tweakedSecretKey),
      tree.keyPath.domain
    )
    expect(ck1).toBe(tree.keyPath.ck1)
    expect(checkSpend(decodeSpend(ck1)!, tree.keyPath.domain).status).toBe(
      'valid'
    )
  })

  it.each(tree.leaves.map((l: any, i: number) => [i, l.verdict, l]))(
    'leaf %i: %s',
    (_, verdict, leaf: any) => {
      const script = hexToBytes(leaf.script)
      expect(bytesToHex(tapleafHash(script, leaf.version))).toBe(
        leaf.tapleafHash
      )
      // the control block folds to Q whatever the leaf's policy
      expect(
        bytesToHex(scriptPathOutputKey(script, hexToBytes(leaf.controlBlock))!)
      ).toBe(tree.Q)
      const spend = decodeSpend(leaf.cw1)
      if (verdict === 'accept') {
        expect(bytesToHex(spend!.q)).toBe(tree.Q)
        expect(checkSpend(spend!, 'mint.example').status).toBe('valid')
      } else {
        expect(spend).toBeNull()
        expect(leafProblem(leaf.version, script)).not.toBeNull()
      }
    }
  )
})

describe('a signature inside a leaf (BIP-342)', () => {
  const cs = v.checksig
  const q = hexToBytes(cs.Q)
  const leafHash = tapleafHash(hexToBytes(cs.leaf))

  it.each(cs.spends.map((s: any) => [s.locktime, s.sequence, s]))(
    'claims locktime %i, sequence %i',
    (locktime, sequence, s: any) => {
      const claim = {locktime, sequence}
      expect(bytesToHex(spendSigMsg(q, cs.domain, claim, leafHash))).toBe(
        s.sigMsg
      )
      expect(bytesToHex(spendSighash(q, cs.domain, claim, leafHash))).toBe(
        s.sighash
      )
      const spend = decodeSpend(s.cw1)!
      expect(bytesToHex(spend.q)).toBe(cs.Q)
      expect(checkSpend(spend, cs.domain).status).toBe('valid')
      expect(checkSpend(spend, 'another.example').status).toBe('invalid')
    }
  )
})

describe('time claims, on the mint clock', () => {
  it.each(v.timeClaims.map((c: any) => [c.name, c.verdict, c]))(
    '%s: %s',
    (_, verdict, c: any) => {
      const problem = timeClaimProblem(
        {locktime: c.locktime, sequence: c.sequence},
        c.now,
        c.lockedAt
      )
      expect(problem === null ? 'accept' : 'reject').toBe(verdict)
    }
  )
})

describe('leaf policy', () => {
  it.each(v.leafPolicy.map((p: any) => [p.name, p.verdict, p]))(
    '%s: %s',
    (_, verdict, p: any) => {
      const problem = leafProblem(p.version, hexToBytes(p.script))
      expect(problem === null ? 'allowed' : 'refused').toBe(verdict)
    }
  )
})

describe('malformed spends and keys', () => {
  it.each(v.malformedCw1.map((m: any) => [m.name, m]))(
    'refuses a cw1: %s',
    (_, m: any) => {
      expect(decodeSpend(m.value)).toBeNull()
    }
  )

  it.each(v.invalidCp1.map((c: any) => [c.why, c]))(
    'refuses a cp1: %s',
    (_, c: any) => {
      expect(decodeCp1(c.cp1)).toBeNull()
      expect(noteRefQ(c.cp1)).toBeNull()
    }
  )

  it('keeps a cw1 that decodes structurally apart from one that opens a note', () => {
    // the wrong parity bit still decodes as bytes, but opens no Q
    const wrongParity = v.malformedCw1.find(
      (m: any) => m.name === 'the wrong parity bit'
    )
    expect(decodeCw1(wrongParity.value)).not.toBeNull()
    expect(decodeSpend(wrongParity.value)).toBeNull()
  })
})

describe('short forms', () => {
  it.each(v.shortForms.map((s: any, i: number) => [i, s]))(
    'pair %i names one note',
    (_, s: any) => {
      expect(bytesToHex(noteRefQ(s.cp1Slot.hex)!)).toBe(s.Q)
      expect(bytesToHex(noteRefQ(s.cp1Slot.sameAs)!)).toBe(s.Q)
      expect(bytesToHex(decodeSpend(s.k1Slot.hex)!.q)).toBe(s.Q)
      expect(bytesToHex(decodeSpend(s.k1Slot.sameAs)!.q)).toBe(s.Q)
    }
  )
})

// Key-path notes from a seed (Seed & derivation, Key-path notes, Offline
// verification, Lightning Address auto-mint) against part2.json, the
// reference wallet's own address branches under BIP-39 seeds.
import {describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {vectors} from '../conformance.ts'
import {bytesToHex, hexToBytes} from '../../src/spec/bytes.ts'
import {
  addressProofDigest,
  branchExport,
  branchNode,
  cashRoot,
  domainPath,
  notePubkey,
  noteSecretKey
} from '../../src/spec/derivation.ts'
import {
  decodeCk1,
  decodeCp1,
  decodeCs1,
  decodeCx1,
  encodeCp1,
  encodeCx1
} from '../../src/spec/encoding.ts'
import {signKeySpend} from '../../src/spec/notes.ts'
import {KEY_PATH_CLAIM, spendSighash} from '../../src/spec/spend.ts'
import {signCertificate, verifyCertificate} from '../../src/spec/certificate.ts'
import {KeyRing, spendDomainOfHost} from '../../src/wallet/keys.ts'
import {seedOf} from '../../src/wallet/vault.ts'
import {legacySecretKey} from '../../src/wallet/legacy.ts'
import {schnorr} from '@noble/curves/secp256k1.js'

const v = vectors('part2')

describe.each(
  v.branches.map((b: any) => [b.host, b.mnemonic.split(' ').at(-1), b])
)('the branch for %s under the "... %s" seed', (_, __, b: any) => {
  const seed = seedOf(b.mnemonic)
  const root = cashRoot(HDKey.fromMasterSeed(seed))
  // derived from the host exactly as stored, port included
  const node = branchNode(root, b.host)

  it('has the reference seed, root and branch', () => {
    expect(bytesToHex(seed)).toBe(b.seedHex)
    expect(domainPath(root, b.host)).toEqual(b.domainIndices)
    expect(bytesToHex(node.publicKey!.slice(1))).toBe(b.branchPubkey)
    expect(bytesToHex(node.chainCode!)).toBe(b.chainCode)
    expect(encodeCx1(branchExport(node))).toBe(b.cx1)
    expect(spendDomainOfHost(b.host)).toBe(b.domain)
  })

  it.each(b.notes.map((n: any) => [n.purpose, n.index, n]))(
    'purpose %i index %i: key, sighash and ck1 for the hostname',
    (purpose, index, n: any) => {
      const pk = notePubkey(branchExport(node), purpose, index)
      const sk = noteSecretKey(node, purpose, index)
      expect(bytesToHex(pk)).toBe(n.notePubkey)
      expect(bytesToHex(sk)).toBe(n.noteSecretKey)
      expect(encodeCp1(pk)).toBe(n.cp1)
      expect(bytesToHex(spendSighash(pk, b.domain, KEY_PATH_CLAIM))).toBe(
        n.sighash
      )
      expect(signKeySpend(sk, b.domain)).toBe(n.ck1)
    }
  )

  it('is what the wallet key ring derives for a mint at that host', () => {
    const keys = new KeyRing(seed)
    expect(keys.cx1(b.host)).toBe(b.cx1)
    for (const n of b.notes) {
      const key = {purpose: n.purpose, index: n.index}
      expect(keys.q(b.host, key)).toBe(n.notePubkey)
      expect(keys.spend(b.host, key)).toBe(n.ck1)
    }
  })
})

describe('the derivation before purposes (superseded, read by the import)', () => {
  const p = v.prePurpose
  const node = branchNode(
    cashRoot(HDKey.fromMasterSeed(seedOf(p.mnemonic))),
    p.host
  )

  it('shares its branch with today', () => {
    expect(encodeCx1(branchExport(node))).toBe(p.cx1)
  })

  it.each(p.notes.map((n: any) => [n.index, n]))(
    'index %i',
    (index, n: any) => {
      const sk = legacySecretKey(node, index)
      expect(bytesToHex(sk)).toBe(n.noteSecretKey)
      expect(bytesToHex(schnorr.getPublicKey(sk))).toBe(n.notePubkey)
      expect(encodeCp1(schnorr.getPublicKey(sk))).toBe(n.cp1)
    }
  )
})

describe('certificates over a key-path note', () => {
  it.each(v.certificates.map((c: any) => [c.amountMsat, c]))(
    '%i msat',
    (amountMsat, c: any) => {
      const q = hexToBytes(c.notePubkey)
      expect(
        signCertificate(amountMsat, q, hexToBytes(v.mint.privateKey))
      ).toBe(c.cs1)
      expect(verifyCertificate(c.cs1, q, v.mint.mintPubkey)).toBe(amountMsat)
      expect(bytesToHex(decodeCs1(c.cs1)!.signature)).toBe(c.signature)
    }
  )
})

describe('Lightning Address proofs', () => {
  it.each(v.addressProofs.map((a: any) => [a.action, a.domain, a.username, a]))(
    '%s at %s for %s',
    (action, domain, username, a: any) => {
      const digest = addressProofDigest(action, domain, username)
      expect(bytesToHex(digest)).toBe(a.digest)
      expect(
        bytesToHex(
          schnorr.sign(
            digest,
            hexToBytes(a.indexZeroSecretKey),
            new Uint8Array(32)
          )
        )
      ).toBe(a.signature)
      expect(
        schnorr.verify(
          hexToBytes(a.signature),
          digest,
          hexToBytes(a.indexZeroPubkey)
        )
      ).toBe(true)
    }
  )
})

describe('encodings', () => {
  const decoders: Record<string, (value: string) => unknown> = {
    cp1: decodeCp1,
    ck1: decodeCk1,
    cs1: decodeCs1,
    cx1: decodeCx1
  }

  it.each(v.valid.map((x: any) => [x.type, x.why, x]))(
    'accepts a %s: %s',
    (type, _, x: any) => {
      expect(bytesToHex(decoders[type](x.value) as Uint8Array)).toBe(x.bytes)
    }
  )

  it.each(v.invalid.map((x: any) => [x.type, x.why, x]))(
    'refuses a %s: %s',
    (type, _, x: any) => {
      expect(decoders[type](x.value)).toBeNull()
    }
  )
})

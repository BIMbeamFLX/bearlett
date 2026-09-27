// LUD-25's own test vectors 1-5 (lnurl/luds 50d740a), as the conformance
// suite carries them byte for byte.
import {describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {vectors} from '../conformance.ts'
import {bytesToHex, hexToBytes, sha256} from '../../src/spec/bytes.ts'
import {
  addressProofDigest,
  branchExport,
  branchNode,
  cashRoot,
  domainPath,
  notePubkey,
  noteSecretKey,
  signAddressProof
} from '../../src/spec/derivation.ts'
import {decodeCp1, encodeCp1, encodeCx1} from '../../src/spec/encoding.ts'
import {
  KEY_PATH_CLAIM,
  canonicalSpendTx,
  mintOutpointTxid,
  noteScriptPubkey,
  spendSigMsg,
  spendSighash
} from '../../src/spec/spend.ts'
import {
  bearerCw1,
  bearerNote,
  checkSpend,
  decodeSpend,
  noteRefQ,
  signKeySpend
} from '../../src/spec/notes.ts'
import {tapleafHash} from '../../src/spec/taproot.ts'
import {
  certificateDigest,
  certificateMessage,
  signCertificate,
  verifyCertificate
} from '../../src/spec/certificate.ts'
import {parseNoteLink} from '../../src/lnurl/links.ts'

const spec = vectors('spec-vectors')

describe.each([
  ['vector 1 (odd-y branch)', spec.vector1],
  ['vector 2 (even-y branch)', spec.vector2]
])('Seed & derivation, %s', (_, v) => {
  const root = cashRoot(HDKey.fromMasterSeed(hexToBytes(v.seedHex)))
  const node = branchNode(root, v.domain)

  it('reaches the branch root through LUD-05 domain hashing under m/139', () => {
    expect(bytesToHex(root.deriveChild(0).privateKey!)).toBe(v.cashHashingKey)
    expect(domainPath(root, v.domain)).toEqual(v.domainIndices)
    expect(bytesToHex(node.privateKey!)).toBe(v.branchPrivateKey)
    expect(bytesToHex(node.publicKey!)).toBe(v.branchPubkeyCompressed)
    expect(bytesToHex(node.chainCode!)).toBe(v.chainCode)
    expect(encodeCx1(branchExport(node))).toBe(v.cx1)
  })

  it.each(v.notes.map((n: any) => [n.purpose, n.index, n]))(
    'derives purpose %i index %i from the export and the secret alike',
    (purpose, index, n: any) => {
      const pk = notePubkey(branchExport(node), purpose, index)
      expect(bytesToHex(pk)).toBe(n.pk)
      expect(bytesToHex(noteSecretKey(node, purpose, index))).toBe(n.sk)
      expect(encodeCp1(pk)).toBe(n.cp1)
      expect(bytesToHex(decodeCp1(n.cp1)!)).toBe(n.pk)
    }
  )

  it.each((v.addressProofs ?? []).map((p: any) => [p.action, p]))(
    'signs the %s proof with the purpose-0 index-0 key',
    (action, p: any) => {
      expect(bytesToHex(addressProofDigest(action, p.domain, p.username))).toBe(
        p.digest
      )
      expect(
        bytesToHex(signAddressProof(node, action, p.domain, p.username))
      ).toBe(p.signature)
    }
  )
})

describe('vector 3: key-path spend', () => {
  const v = spec.vector3
  const q = hexToBytes(v.Q)

  it('binds the mint and the note into the signature message', () => {
    expect(bytesToHex(mintOutpointTxid(v.domain))).toBe(v.prevoutTxid)
    expect(bytesToHex(noteScriptPubkey(q))).toBe(v.spentScriptPubKey)
    expect(bytesToHex(spendSigMsg(q, v.domain, KEY_PATH_CLAIM))).toBe(v.sigMsg)
    expect(bytesToHex(spendSighash(q, v.domain, KEY_PATH_CLAIM))).toBe(
      v.sighash
    )
  })

  it('signs deterministically, and the ck1 opens Q only at its own domain', () => {
    const ck1 = signKeySpend(hexToBytes(v.secretKey), v.domain)
    expect(ck1).toBe(v.ck1)
    const spend = decodeSpend(ck1)!
    expect(spend.kind).toBe('key')
    expect(checkSpend(spend, v.domain).status).toBe('valid')
    expect(checkSpend(spend, 'other.example').status).toBe('invalid')
    const sig = spend.kind === 'key' ? spend.sig : new Uint8Array()
    expect(bytesToHex(canonicalSpendTx(v.domain, KEY_PATH_CLAIM, [sig]))).toBe(
      v.spendTransaction
    )
  })
})

describe('vector 4: certificates', () => {
  const v = spec.vector4
  const q = hexToBytes(v.notePubkey)

  it.each(v.certificates.map((c: any) => [c.amountMsat, c]))(
    'certifies %i msat and recovers the mint key from it',
    (amountMsat, c: any) => {
      expect(certificateMessage(amountMsat, q)).toBe(c.message)
      expect(bytesToHex(certificateDigest(amountMsat, q))).toBe(c.digest)
      expect(signCertificate(amountMsat, q, hexToBytes(v.mintPrivateKey))).toBe(
        c.cs1
      )
      expect(verifyCertificate(c.cs1, q, v.mintPubkey)).toBe(amountMsat)
      expect(
        verifyCertificate(c.cs1, hexToBytes(v.otherNotePubkey), v.mintPubkey)
      ).toBeNull()
    }
  )
})

describe('vector 5: bearer note', () => {
  const v = spec.vector5
  const preimage = hexToBytes(v.preimage)
  const note = bearerNote(sha256(preimage))

  it('builds the hashlock note under NUMS', () => {
    expect(bytesToHex(sha256(preimage))).toBe(v.h)
    expect(bytesToHex(note.leaf)).toBe(v.leaf)
    expect(bytesToHex(tapleafHash(note.leaf))).toBe(v.tapleafHash)
    expect(bytesToHex(note.q)).toBe(v.Q)
    expect(bytesToHex(note.control)).toBe(v.controlBlock)
    expect(encodeCp1(note.q)).toBe(v.cp1)
    expect(bearerCw1(preimage)).toBe(v.cw1)
  })

  it('treats both short forms as the note and its spend', () => {
    expect(bytesToHex(noteRefQ(v.h)!)).toBe(v.Q)
    expect(bytesToHex(decodeSpend(v.preimage)!.q)).toBe(v.Q)
    expect(bytesToHex(decodeSpend(v.cw1)!.q)).toBe(v.Q)
    expect(checkSpend(decodeSpend(v.cw1)!, 'any.example').status).toBe('valid')
  })

  it('verifies the certified note link offline', () => {
    const link = parseNoteLink(v.certifiedNoteUrl)!
    expect(link.k1).toBe(v.preimage)
    expect(verifyCertificate(link.c!, note.q, v.mintPubkey)).toBe(1000)
  })
})

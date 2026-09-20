import {describe, expect, it} from 'vitest'
import {HDKey} from '@scure/bip32'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  CASH_ROOT_PURPOSE,
  decodeCs1WithAmount,
  deriveDomainBranchNode,
  deriveNotePubkey,
  deriveNoteSecretKey,
  encodeCk1,
  encodeCp1,
  encodeCx1,
  recoverNoteOwnershipPubkey,
  signAddressProof,
  signNoteOwnership,
  verifyNoteSignatureHash
} from './lnurlcash'

// LUD-25 "Test Vectors", lnurl/luds branch lnurlcash at 265759f
// (18 September 2026). Pins the protocol layer this wallet re-exports from
// @lnurlcash/kit to the draft byte for byte, so a kit upgrade that drifts
// from the spec fails here before it can touch a note.

const cashRoot = (seedHex: string): HDKey =>
  // CASH_ROOT_PURPOSE is already the hardened index 139'
  HDKey.fromMasterSeed(hexToBytes(seedHex)).deriveChild(CASH_ROOT_PURPOSE)

describe('LUD-25 test vector 1: seed & derivation, odd-y branch key', () => {
  const branch = deriveDomainBranchNode(
    cashRoot('000102030405060708090a0b0c0d0e0f'),
    'mint.example'
  )
  const P = branch.publicKey!.slice(1)
  const chainCode = branch.chainCode!

  it("derives the branch root m/139'/d1/d2/d3/d4", () => {
    expect(bytesToHex(branch.privateKey!)).toBe(
      '7bbab40e4a022ea909cfee28eb1c7a9f56cf746feea94ff73f155a14f2c57d1e'
    )
    expect(bytesToHex(branch.publicKey!)).toBe(
      '03b783d2930dc053a971f019054ca43e7c9de50e0769de872dd1ddde5d0bf4c9d1'
    )
    expect(bytesToHex(chainCode)).toBe(
      'ab91cc11aea395ea6b62292a6147f51ef4150ebea04e745137b68719e238f904'
    )
    expect(encodeCx1(P, chainCode)).toBe(
      'cx1k7pa9ycdcpf6ju0sryz5efp70jw72rs8d80gwtw3mh096zl5e8g6hywvzxh28902dd3zj2npgl63aaq4p6l2qnn52ymmdpceugu0jpqes280t'
    )
  })

  it.each([
    [
      0,
      'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634',
      '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f',
      'cp14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc6qh2fkky'
    ],
    [
      1,
      'f0c1ea9aede945b9cf84f3bf8df27ac65154a937e4d10cb8a5865df0583b1083',
      '8d094de89f623b5b58c181e5de832a7783261ab88be5b8119b64bce6b080a23c',
      'cp17rq74xhda9zmnnuy7wlcmun6ceg4f2fhungsew99sewlqkpmzzpsf28ex8'
    ],
    [
      5,
      'c2b6a6d230d3ca51cc680bf84948c416eab70109542a0cf4fd1fbebbd647891a',
      'cad168ceaefbe2ebe96d3d2369201fbf6421a4548a57f8839880b1618dea298b',
      'cp1c2m2d53s6099rnrgp0uyjjxyzm4twqgf2s4qea8ar7lth4j83ydqcznzj6'
    ]
  ])('derives note key i=%i from the branch', (i, pk, sk, cp1) => {
    const pubkey = deriveNotePubkey(P, chainCode, i)
    expect(bytesToHex(pubkey)).toBe(pk)
    expect(
      bytesToHex(deriveNoteSecretKey(branch.privateKey!, chainCode, i))
    ).toBe(sk)
    expect(encodeCp1(pubkey)).toBe(cp1)
  })
})

describe('LUD-25 test vector 2: even-y branch key + LN address proof', () => {
  const branch = deriveDomainBranchNode(
    cashRoot(
      'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542'
    ),
    'cash.example.com'
  )

  it('derives the branch root and sk_0', () => {
    expect(bytesToHex(branch.privateKey!)).toBe(
      '6f1d381ccdda9a69f966b492b19de687930c19b19e7f8d581088402d6a3b7818'
    )
    expect(
      bytesToHex(deriveNoteSecretKey(branch.privateKey!, branch.chainCode!, 0))
    ).toBe('bc1e4427b38f7b48ef379ff7cefbef6612cf84a0f582b06c90bf6b51d2c89f29')
  })

  it('signs register and unregister proofs bound to the domain', () => {
    const sk0 = deriveNoteSecretKey(branch.privateKey!, branch.chainCode!, 0)
    expect(
      bytesToHex(signAddressProof(sk0, 'register', 'cash.example.com', 'alice'))
    ).toBe(
      '9d96780fe55f602a9e238a4b2640a9f8ca939cacbbcde109cfd6ba94a6f9d46ff4aaf56ba1e4e72696f7c0e8833445bd194bd06155a133cf524eb587d52e8d22'
    )
    expect(
      bytesToHex(
        signAddressProof(sk0, 'unregister', 'cash.example.com', 'alice')
      )
    ).toBe(
      '7250ab2403333eb5ed73f7a212ac4f35b58f426fe5c2acb8b2194a112881332bfbeebeba0bc4615bcf361bc125d5a4149ddbe4b6ea3b755b711fefd8bba58728'
    )
  })
})

describe('LUD-25 test vector 3: wallet-side ownership proof (ck1)', () => {
  const CK1 =
    'ck14tf6pcmvpqltp5ke9mqgvzthm3rdzry49uccxrnygwcl4gvewc62s0003psm2kxx7p8dsal9arwd7e6usu04cjens0qhywer99jc5sz9zqptmg4gyjlgg2zpglhl8atjj6zsfsh5ffnzn4k73naafcukpgdezzqx'

  it('signs sha256("LNURLcash") deterministically with sk_0', () => {
    const {pubkeyXOnly, signature} = signNoteOwnership(
      hexToBytes(
        '944a9631dbda27cf989e27df8be7317a5a9dfb517a6b71358d175f58dd2dc99f'
      )
    )
    expect(bytesToHex(pubkeyXOnly)).toBe(
      'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
    )
    expect(bytesToHex(signature)).toBe(
      'a83def8861b558c6f04ed877e5e8dcdf675c871f5c4b3383c1723b2329658a40451002bda2a824be84284147eff3f572968504c2f44a6629d6de8cfbd4e3960a'
    )
    expect(encodeCk1(pubkeyXOnly, signature)).toBe(CK1)
  })

  it('verifies the embedded pubkey straight off the ck1', () => {
    const recovered = recoverNoteOwnershipPubkey(CK1)
    expect(recovered?.legacy).toBe(false)
    expect(bytesToHex(recovered!.pubkeyXOnly)).toBe(
      'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'
    )
  })
})

describe('LUD-25 test vector 4: mint certificate (cs1)', () => {
  const MINT_PUBKEY =
    '035acdbd57663f858be6d61ec4bfcbc99492699010f1451e30a6550f26295e813d'
  const PK = 'aad3a0e36c083eb0d2d92ec0860977dc46d10c952f31830e6443b1faa1997634'

  it.each([
    [
      'cs10n1gxnfct5zv42mr3wqnxe3vm5d2rxrhwarejumslph06t2upcd2vkrkc3sr99wjlfj94nrlvuzv64ayme420rz5l2622xwn3ed8qu0llqpeg9n5x',
      1000
    ],
    [
      'cs210u1khrv8hg4zuy9qx7gsg9wqrhn6epeehx23wkqp7exwhlwdwy6wans083h7ckz2qkxw399v22ugkw49sz8tcn6p6e5w3tepdzv2junscsqwvvr03',
      21000000
    ]
  ])('recovers mintPubkey from %s', (cs1, amountMsat) => {
    const decoded = decodeCs1WithAmount(cs1)
    expect(decoded?.amountMsat).toBe(amountMsat)
    expect(
      verifyNoteSignatureHash(
        PK,
        amountMsat,
        bytesToHex(decoded!.signature),
        MINT_PUBKEY
      )
    ).toBe(true)
    expect(
      verifyNoteSignatureHash(
        PK,
        amountMsat + 1,
        bytesToHex(decoded!.signature),
        MINT_PUBKEY
      )
    ).toBe(false)
  })
})

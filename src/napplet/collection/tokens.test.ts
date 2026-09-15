import {describe, expect, it} from 'vitest'
import * as cashu from '@cashu/cashu-ts'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {TestNutftMint} from './fixture'
import {decodeCards, encodeCards} from './tokens'

const holder = bytesToHex(
  cashu.getPubKeyFromPrivKey(hexToBytes('2b'.repeat(32)))
)

describe('decodeCards', () => {
  it('reads a token with a short keyset id without the keyset', () => {
    const mint = new TestNutftMint()
    const token = mint.issue(holder, 1)
    const cards = decodeCards(token, cashu)
    expect(cards.mint).toBe(mint.url)
    expect(cards.unit).toBe(mint.unit)
    expect(cards.proofs).toHaveLength(1)
    /* The short form, exactly as the token carries it. */
    expect(mint.id.startsWith(cards.proofs[0].id)).toBe(true)
    expect(cards.proofs[0].secret).toBe(
      cashu.getTokenMetadata(token).incompleteProofs[0].secret
    )
  })

  it('reads a version 3 token', () => {
    const mint = new TestNutftMint()
    const [proof] = cashu.getDecodedToken(mint.issue(holder, 2), [
      mint.id
    ]).proofs
    const v3 = `cashuA${btoa(
      JSON.stringify({
        token: [{mint: mint.url, proofs: [{...proof, amount: 1}]}],
        unit: mint.unit
      })
    )}`
    const cards = decodeCards(v3, cashu)
    expect(cards.mint).toBe(mint.url)
    expect(cards.proofs[0].secret).toBe(proof.secret)
  })

  it('refuses what is not a token', () => {
    for (const text of ['cashuC', 'hello', 'cashuB!!', 'cashuA' + btoa('{}')])
      expect(() => decodeCards(text, cashu)).toThrow()
  })
})

describe('encodeCards', () => {
  it('writes a token the card library and cashu-ts read back', () => {
    const mint = new TestNutftMint()
    const cards = decodeCards(mint.issue(holder, 3), cashu)
    const token = encodeCards({...cards, mint: `${mint.url}/renamed`}, cashu)
    expect(token.startsWith('cashuB')).toBe(true)
    const read = cashu.getDecodedToken(token, [mint.id])
    expect(read.mint).toBe(`${mint.url}/renamed`)
    expect(read.proofs[0].secret).toBe(cards.proofs[0].secret)
    expect(read.proofs[0].C).toBe(cards.proofs[0].C)
    expect(read.proofs[0].id).toBe(mint.id)
    expect(decodeCards(token, cashu)).toEqual({
      ...cards,
      mint: `${mint.url}/renamed`
    })
  })
})

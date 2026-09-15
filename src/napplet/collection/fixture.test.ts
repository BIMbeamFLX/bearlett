import {describe, expect, it} from 'vitest'
import {
  OutputData,
  getDecodedToken,
  getPubKeyFromPrivKey,
  getTokenMetadata
} from '@cashu/cashu-ts'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {TestNutftMint} from './fixture'

const holder = bytesToHex(getPubKeyFromPrivKey(hexToBytes('2b'.repeat(32))))

/* A trade body the fixture accepts: one issued card in, one output with the
   same card binding out. The fixture does not check owner witnesses. */
const tradeOf = (mint: TestNutftMint, key: string, output: OutputData) => {
  const [proof] = getDecodedToken(mint.issue(holder, 1), [mint.id]).proofs
  return {
    mint: mint.url,
    operation: 'trade' as const,
    body: JSON.stringify({
      idempotency_key: key,
      inputs: [JSON.stringify({...proof, amount: 1})],
      outputs: [
        {
          amount: 1,
          id: mint.id,
          B_: output.blindedMessage.B_,
          nutft: {secret: new TextDecoder().decode(output.secret)}
        }
      ]
    })
  }
}

describe('the fixture mint', () => {
  it('serves a version 2 keyset id, and issues tokens with its short form', () => {
    const mint = new TestNutftMint()
    expect(mint.id).toMatch(/^01[0-9a-f]{64}$/)
    const token = mint.issue(holder)
    expect(getTokenMetadata(token).mint).toBe(mint.url)
    /* Without the full id the short one cannot be read back, as in production. */
    expect(() => getDecodedToken(token, [])).toThrow()
    expect(getDecodedToken(token, [mint.id]).proofs[0].id).toBe(mint.id)
  })

  it('refuses to sign an output it has already signed, as the mint does', async () => {
    const mint = new TestNutftMint()
    const asset = mint.catalog.assets[1]
    const output = OutputData.createSingleP2PKData(
      {
        pubkey: holder,
        blindKeys: true,
        additionalTags: [
          [
            'nutft',
            '1',
            mint.unit,
            asset.asset_id,
            mint.catalog.catalog_uri,
            asset.asset_binding
          ]
        ]
      },
      1,
      mint.id
    )
    const first = await mint.request(tradeOf(mint, 'first', output))
    expect(first.status).toBe(200)
    /* The same key is an idempotent replay and gets the same answer. */
    expect(await mint.request(tradeOf(mint, 'first', output))).toEqual(first)
    const second = await mint.request(tradeOf(mint, 'second', output))
    expect(second.status).toBe(400)
    expect(JSON.parse(second.body)).toEqual({
      error: 'output was already signed'
    })
  })
})

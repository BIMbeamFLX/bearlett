import {describe, expect, it} from 'vitest'
import {nutftAssetId, previewsFromSecrets} from './preview'
import type {CardAsset} from './cards'

const secret = (assetId: string): string =>
  JSON.stringify([
    'P2PK',
    {
      nonce: 'ab',
      data: 'cd',
      tags: [['nutft', '1', '600B-E1', assetId, 'catalog', 'binding']]
    }
  ])

const asset = (assetId: string, name: string): CardAsset => ({
  asset_id: assetId,
  name,
  tier: 'Genesis',
  type_line: 'Protocol',
  copies: 63,
  face: {
    sha256: 'a'.repeat(64),
    mime: 'image/webp',
    bytes: 10,
    urls: ['https://blossom.example/a.webp']
  },
  asset_binding: 'b'.repeat(64)
})

describe('card preview', () => {
  it('reads the asset id and nothing else from the secret', () => {
    expect(nutftAssetId(secret('E1-001'))).toBe('E1-001')
    expect(nutftAssetId('not json')).toBeNull()
    expect(
      nutftAssetId(JSON.stringify(['P2PK', {tags: [['nope']]}]))
    ).toBeNull()
    const shown = previewsFromSecrets(
      [secret('E1-001'), secret('E1-999')],
      [asset('E1-001', 'Genesis Lotus')]
    )
    expect(shown.map(card => card.name)).toEqual([
      'Genesis Lotus',
      'Card from this collection'
    ])
    expect(JSON.stringify(shown)).not.toContain('nonce')
  })
})

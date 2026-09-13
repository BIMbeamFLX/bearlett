import {describe, expect, it} from 'vitest'
import {
  INVENTORY_CONVENTION,
  MAX_INVENTORY_CARDS,
  buildInventory,
  isInventoryRequest,
  parseInventory
} from './inventory'
import type {Inventory} from './inventory'
import type {CollectionEdition} from './bootstrap'
import type {CardAsset, OwnedItem, Snapshot} from './cards'

const EDITION: CollectionEdition = {
  id: '600b-e1',
  mint: 'https://mint.example/e1',
  units: ['600B-E1'],
  mirrors: ['https://blossom.primal.net']
}
const CATALOG_URI = 'https://mint.example/e1/nutft/catalog'

const asset = (asset_id: string): CardAsset => ({
  asset_id,
  name: asset_id,
  tier: 'Common',
  type_line: 'Hardware',
  copies: 100,
  face: {
    sha256: 'a'.repeat(64),
    mime: 'image/webp',
    bytes: 1000,
    urls: ['https://blossom.primal.net/x.webp']
  },
  asset_binding: 'b'.repeat(64)
})

/* Shaped after what the vendored library's `snapshot()` returns: the proof
   with its secret, the signed nutft tag, and the resolved catalogue entry. */
const held = (asset_id: string, index = 0): OwnedItem => ({
  asset: asset(asset_id),
  Y: `02${'c'.repeat(62)}`,
  state: 'UNSPENT',
  proof: {
    amount: 1,
    id: '00deadbeef',
    secret: `["P2BK",{"nonce":"n${index}","data":"02${'d'.repeat(62)}"}]`,
    C: `03${'e'.repeat(62)}`,
    p2pk_e: `02${'f'.repeat(62)}`
  },
  tag: ['1', '600B-E1', asset_id, CATALOG_URI, 'b'.repeat(64)]
})

const snapshot = (owned: OwnedItem[]): Snapshot => ({
  catalog: {
    collection_id: '600B-E1',
    catalog_uri: CATALOG_URI,
    issuer_pubkey: '1'.repeat(64),
    assets: owned.map(item => item.asset)
  },
  owned,
  spent: [held('E1-999')],
  invalid: [{error: 'proof is not addressed to this wallet'}],
  unreadable: [{}]
})

const NOW = 1757800000

describe('buildInventory', () => {
  /* Two copies of one card, one of another, handed in out of order. */
  const built = buildInventory(
    EDITION,
    snapshot([held('E1-042'), held('E1-001', 0), held('E1-001', 1)]),
    NOW
  )

  it('counts copies per asset id, sorted by asset id', () => {
    expect(built).toEqual({
      v: 1,
      kind: 'nutft/inventory',
      edition: '600b-e1',
      collection_id: '600B-E1',
      catalog_uri: CATALOG_URI,
      mint: 'https://mint.example/e1',
      at: NOW,
      cards: [
        {asset_id: 'E1-001', count: 2},
        {asset_id: 'E1-042', count: 1}
      ]
    })
  })

  it('leaves spent, invalid and unreadable cards out', () => {
    expect(built.cards.map(card => card.asset_id)).not.toContain('E1-999')
  })

  it('carries no proof, secret or pubkey anywhere in its JSON', () => {
    const json = JSON.stringify(built)
    expect(json).not.toMatch(/proof|secret|pubkey|p2pk|"Y"|"C"/i)
    expect(json).not.toContain('c'.repeat(62))
    expect(json).not.toContain('d'.repeat(62))
    const keys = new Set<string>()
    JSON.parse(json, (key, value) => {
      /* The reviver also reports array indices; only field names matter. */
      if (!/^\d+$/.test(key)) keys.add(key)
      return value
    })
    expect([...keys].sort()).toEqual([
      '',
      'asset_id',
      'at',
      'cards',
      'catalog_uri',
      'collection_id',
      'count',
      'edition',
      'kind',
      'mint',
      'v'
    ])
  })

  it('counts by the signed tag, not by the resolved catalogue entry', () => {
    const odd = held('E1-007')
    odd.tag = ['1', '600B-E1', 'E1-008', CATALOG_URI, 'b'.repeat(64)]
    expect(buildInventory(EDITION, snapshot([odd]), NOW).cards).toEqual([
      {asset_id: 'E1-008', count: 1}
    ])
  })

  it('is empty, not absent, when nothing is held and no catalogue is known', () => {
    const empty = buildInventory(
      EDITION,
      {catalog: null, owned: [], spent: [], invalid: [], unreadable: []},
      NOW + 0.9
    )
    expect(empty.cards).toEqual([])
    expect(empty.catalog_uri).toBe('')
    expect(empty.at).toBe(NOW)
  })

  it('names the convention the manifest declares', () => {
    expect(INVENTORY_CONVENTION).toBe('napplet:collection/inventory')
  })
})

describe('parseInventory', () => {
  const built = buildInventory(
    EDITION,
    snapshot([held('E1-042'), held('E1-001', 0), held('E1-001', 1)]),
    NOW
  )
  const json = JSON.stringify(built)

  it('round-trips its own output', () => {
    const parsed = parseInventory(JSON.parse(json))
    expect(parsed).toEqual(built)
    expect(parsed).not.toBe(built)
  })

  const variant = (change: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(json) as Record<string, unknown>
    change(copy)
    return copy
  }

  it('rejects an extra top-level field', () => {
    expect(() => parseInventory(variant(c => (c.proofs = [])))).toThrow(
      /unexpected "proofs"/
    )
  })

  it('rejects a card with an extra field', () => {
    expect(() =>
      parseInventory(
        variant(c => {
          ;(c.cards as Record<string, unknown>[])[0].secret = 'x'
        })
      )
    ).toThrow(/card 0 has an unexpected "secret"/)
  })

  it('rejects a missing field', () => {
    expect(() => parseInventory(variant(c => delete c.mint))).toThrow(
      /lacks "mint"/
    )
  })

  it('rejects count 0 and fractional counts', () => {
    expect(() =>
      parseInventory(
        variant(c => ((c.cards as Record<string, unknown>[])[0].count = 0))
      )
    ).toThrow(/positive integer "count"/)
    expect(() =>
      parseInventory(
        variant(c => ((c.cards as Record<string, unknown>[])[0].count = 1.5))
      )
    ).toThrow(/positive integer "count"/)
  })

  it('rejects unsorted and repeated cards', () => {
    expect(() =>
      parseInventory(variant(c => (c.cards as unknown[]).reverse()))
    ).toThrow(/not sorted by asset_id at E1-001/)
    expect(() =>
      parseInventory(
        variant(c => {
          const cards = c.cards as Record<string, unknown>[]
          cards.push({...cards[1]})
        })
      )
    ).toThrow(/not sorted/)
  })

  it('rejects the wrong kind and version', () => {
    expect(() =>
      parseInventory(variant(c => (c.kind = 'nutft/proofs')))
    ).toThrow(/"kind" must be "nutft\/inventory"/)
    expect(() => parseInventory(variant(c => (c.v = 2)))).toThrow(
      /"v" must be 1/
    )
  })

  it('rejects ids that are not strings or are too long', () => {
    expect(() => parseInventory(variant(c => (c.edition = 7)))).toThrow(
      /"edition" must be a string/
    )
    expect(() =>
      parseInventory(
        variant(
          c =>
            ((c.cards as Record<string, unknown>[])[0].asset_id = 'x'.repeat(
              65
            ))
        )
      )
    ).toThrow(/"asset_id" must be a string of 1 to 64/)
    expect(() => parseInventory(variant(c => (c.collection_id = '')))).toThrow(
      /"collection_id"/
    )
  })

  it('rejects a non-integer timestamp', () => {
    expect(() => parseInventory(variant(c => (c.at = -1)))).toThrow(/"at"/)
    expect(() => parseInventory(variant(c => (c.at = '1757800000')))).toThrow(
      /"at"/
    )
  })

  it('accepts 4096 cards and rejects 4097', () => {
    const many = (n: number): Inventory => ({
      ...built,
      cards: Array.from({length: n}, (_, i) => ({
        asset_id: `E1-${String(i).padStart(4, '0')}`,
        count: 1
      }))
    })
    expect(parseInventory(many(MAX_INVENTORY_CARDS)).cards).toHaveLength(4096)
    expect(() => parseInventory(many(MAX_INVENTORY_CARDS + 1))).toThrow(
      /more than 4096/
    )
  })

  it('rejects things that are not objects', () => {
    for (const bad of [null, 'inventory', [], 1, undefined])
      expect(() => parseInventory(bad)).toThrow(/expected an object/)
  })
})

describe('isInventoryRequest', () => {
  it('matches only a v1 request for this edition', () => {
    expect(
      isInventoryRequest(
        {v: 1, kind: 'nutft/inventory-request', edition: '600b-e1'},
        '600b-e1'
      )
    ).toBe(true)
    expect(
      isInventoryRequest(
        {v: 1, kind: 'nutft/inventory-request', edition: '600b-g'},
        '600b-e1'
      )
    ).toBe(false)
    expect(
      isInventoryRequest(
        {v: 1, kind: 'nutft/inventory', edition: '600b-e1'},
        '600b-e1'
      )
    ).toBe(false)
    expect(isInventoryRequest(null, '600b-e1')).toBe(false)
    expect(isInventoryRequest('600b-e1', '600b-e1')).toBe(false)
  })
})

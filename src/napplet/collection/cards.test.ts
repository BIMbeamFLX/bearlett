import {describe, expect, it} from 'vitest'
import {
  buildCollectionView,
  filterStacks,
  scarcityRatio,
  tierOrder
} from './cards'
import type {CardAsset, OwnedItem, Snapshot} from './cards'

/* Shaped after a real 600B-G catalogue entry, copies included, because the
   order the grid uses is derived from copies rather than from tier names. */
const asset = (over: Partial<CardAsset> & {asset_id: string}): CardAsset => ({
  name: over.asset_id,
  tier: 'Common',
  type_line: 'Hardware',
  copies: 100,
  face: {
    sha256: 'a'.repeat(64),
    mime: 'image/webp',
    bytes: 1000,
    urls: ['https://blossom.primal.net/x.webp']
  },
  asset_binding: 'b'.repeat(64),
  ...over
})

const GENESIS = asset({
  asset_id: 'E1-001',
  name: 'Genesis Lotus',
  tier: 'Genesis',
  copies: 3
})
const RARE = asset({
  asset_id: 'E1-042',
  name: 'Cold Storage',
  tier: 'Rare',
  type_line: 'Protocol',
  copies: 40
})
const COMMON = asset({
  asset_id: 'E1-100',
  name: 'Zap Relay',
  tier: 'Common',
  copies: 824
})

const held = (card: CardAsset, index = 0): OwnedItem => ({
  asset: card,
  Y: `${card.asset_id}-${index}`,
  state: 'UNSPENT'
})

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  catalog: {collection_id: '600B-G', assets: [GENESIS, RARE, COMMON]},
  owned: [],
  spent: [],
  invalid: [],
  unreadable: [],
  ...over
})

describe('buildCollectionView', () => {
  it('stacks copies of one card and counts them the way the brief does', () => {
    const view = buildCollectionView(
      snapshot({
        owned: [
          held(COMMON, 0),
          held(GENESIS),
          held(COMMON, 1),
          held(COMMON, 2)
        ]
      })
    )
    expect(view.counters).toEqual({cards: 4, distinct: 2, duplicates: 2})
    const zap = view.stacks.find(s => s.asset.asset_id === 'E1-100')
    expect(zap?.count).toBe(3)
    expect(zap?.items).toHaveLength(3)
  })

  it('puts the rarest card first, by copies and not by tier name', () => {
    const view = buildCollectionView(
      snapshot({owned: [held(COMMON), held(RARE), held(GENESIS)]})
    )
    expect(view.stacks.map(s => s.asset.asset_id)).toEqual([
      'E1-001',
      'E1-042',
      'E1-100'
    ])
  })

  it('breaks a tie by name so the order never wobbles between reads', () => {
    const zed = asset({asset_id: 'E1-200', name: 'Zed', copies: 40})
    const abe = asset({asset_id: 'E1-201', name: 'Abe', copies: 40})
    const first = buildCollectionView(snapshot({owned: [held(zed), held(abe)]}))
    const second = buildCollectionView(
      snapshot({owned: [held(abe), held(zed)]})
    )
    expect(first.stacks.map(s => s.asset.name)).toEqual(['Abe', 'Zed'])
    expect(second.stacks.map(s => s.asset.name)).toEqual(['Abe', 'Zed'])
  })

  it('keeps unreadable and invalid apart, because they mean different things', () => {
    const view = buildCollectionView(
      snapshot({
        invalid: [{error: 'proof is not addressed to this wallet'}, {}],
        unreadable: ['cashuBsomethingelse', 'cashuBanother']
      })
    )
    expect(view.notShown.invalid).toBe(2)
    expect(view.notShown.unreadable).toBe(2)
    expect(view.notShown.reasons).toEqual([
      'proof is not addressed to this wallet'
    ])
  })

  it('reports an empty collection without inventing anything', () => {
    const view = buildCollectionView(snapshot())
    expect(view.counters).toEqual({cards: 0, distinct: 0, duplicates: 0})
    expect(view.stacks).toEqual([])
    expect(view.tiers).toEqual([])
    expect(view.collectionId).toBe('600B-G')
  })

  it('survives a held item the catalogue could not name', () => {
    const view = buildCollectionView(
      snapshot({
        owned: [held(GENESIS), {asset: undefined as never, Y: 'orphan'}]
      })
    )
    expect(view.counters.cards).toBe(1)
  })

  it('offers only the tiers and types actually held', () => {
    const view = buildCollectionView(snapshot({owned: [held(RARE)]}))
    expect(view.tiers).toEqual(['Rare'])
    expect(view.types).toEqual(['Protocol'])
  })
})

describe('tierOrder', () => {
  it('ranks a tier by its scarcest card', () => {
    expect(tierOrder([COMMON, GENESIS, RARE])).toEqual([
      'Genesis',
      'Rare',
      'Common'
    ])
  })

  it('places an unknown tier by its own copies, not last by default', () => {
    const promo = asset({asset_id: 'E1-900', tier: 'Promo', copies: 1})
    expect(tierOrder([COMMON, GENESIS, promo])[0]).toBe('Promo')
  })
})

describe('filterStacks', () => {
  const stacks = buildCollectionView(
    snapshot({
      owned: [held(GENESIS), held(RARE), held(COMMON, 0), held(COMMON, 1)]
    })
  ).stacks

  it('treats an empty filter as no filter', () => {
    expect(filterStacks(stacks, {})).toHaveLength(3)
    expect(filterStacks(stacks, {search: '   '})).toHaveLength(3)
  })

  it('searches name, type line and asset id alike', () => {
    expect(filterStacks(stacks, {search: 'lotus'})[0].asset.name).toBe(
      'Genesis Lotus'
    )
    expect(filterStacks(stacks, {search: 'protocol'})[0].asset.asset_id).toBe(
      'E1-042'
    )
    expect(filterStacks(stacks, {search: 'e1-100'})[0].asset.name).toBe(
      'Zap Relay'
    )
  })

  it('narrows by tier and by type', () => {
    expect(filterStacks(stacks, {tier: 'Genesis'})).toHaveLength(1)
    expect(filterStacks(stacks, {type: 'Protocol'})).toHaveLength(1)
    expect(filterStacks(stacks, {tier: 'Genesis', type: 'Protocol'})).toEqual(
      []
    )
  })

  it('shows only cards actually held more than once', () => {
    const duplicates = filterStacks(stacks, {duplicatesOnly: true})
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].count).toBe(2)
  })
})

describe('scarcityRatio', () => {
  it('states one in N against the whole edition', () => {
    /* 3 + 40 + 824 = 867 printed cards; a Genesis is one in 289. */
    expect(scarcityRatio(GENESIS, [GENESIS, RARE, COMMON])).toBe(289)
    expect(scarcityRatio(COMMON, [GENESIS, RARE, COMMON])).toBe(1)
  })

  it('says nothing rather than dividing by zero', () => {
    expect(scarcityRatio(asset({asset_id: 'x', copies: 0}), [])).toBeNull()
  })
})

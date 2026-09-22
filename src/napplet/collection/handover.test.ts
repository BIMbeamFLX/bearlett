import {describe, expect, it} from 'vitest'
import {
  copyRefs,
  defaultPicks,
  handoverLines,
  pickedCopies,
  togglePick
} from './handover'
import type {CardAsset, CardStack} from './cards'

const asset = (id: string, name: string): CardAsset => ({
  asset_id: id,
  name,
  tier: 'Genesis',
  type_line: 'Protocol',
  copies: 63,
  face: {
    sha256: 'a'.repeat(64),
    mime: 'image/webp',
    bytes: 10,
    urls: []
  },
  asset_binding: 'b'.repeat(64)
})

const stack = (id: string, name: string, count: number): CardStack => ({
  asset: asset(id, name),
  count,
  items: Array.from({length: count}, (_, index) => ({
    asset: asset(id, name),
    Y: `${id}-${index}`,
    proof: {secret: `secret-${id}-${index}`}
  }))
})

describe('handover picks', () => {
  it('offers one named copy of a stack and can send the rest on purpose', () => {
    const copies = copyRefs(
      [stack('E1-001', 'Genesis Lotus', 5), stack('E1-002', 'Vault Key', 1)],
      ['E1-001']
    )
    expect(copies).toHaveLength(5)
    expect(defaultPicks(copies)).toEqual(['E1-001-0'])
    const all = copies.map(copy => copy.y)
    expect(handoverLines(copies, defaultPicks(copies))).toEqual([
      {name: 'Genesis Lotus', sending: 1, staying: 4}
    ])
    expect(handoverLines(copies, all)).toEqual([
      {name: 'Genesis Lotus', sending: 5, staying: 0}
    ])
    expect(
      pickedCopies(copies, togglePick(['E1-001-0'], 'E1-001-1'))
    ).toHaveLength(2)
    expect(pickedCopies(copies, ['E1-001-0']).map(copy => copy.secret)).toEqual(
      ['secret-E1-001-0']
    )
  })
})

import {describe, expect, it} from 'vitest'
import {pickInternalTransferBearers} from './internalTransferPick'
import type {Bearer} from './storage'

const note = (id: string, amount: number): Bearer =>
  ({
    id,
    amount,
    url: `https://mint.example/w?k1=${id}`,
    callback: 'x'
  }) as Bearer

describe('pickInternalTransferBearers', () => {
  it('takes a single exact note first: a plain rotate is free', () => {
    const picked = pickInternalTransferBearers(
      [note('a', 5000), note('b', 2000), note('c', 2000)],
      2000
    )
    expect(picked.map(n => n.id)).toEqual(['b'])
  })

  it('takes everything when the total matches exactly', () => {
    const picked = pickInternalTransferBearers(
      [note('a', 1000), note('b', 2000)],
      3000
    )
    expect(picked.map(n => n.id)).toEqual(['a', 'b'])
  })

  it('otherwise accumulates in order until the amount is covered', () => {
    const picked = pickInternalTransferBearers(
      [note('a', 1000), note('b', 2000), note('c', 4000)],
      2500
    )
    expect(picked.map(n => n.id)).toEqual(['a', 'b'])
  })

  it('hands back a short selection when the notes cannot cover it', () => {
    const picked = pickInternalTransferBearers([note('a', 1000)], 5000)
    expect(picked.map(n => n.id)).toEqual(['a'])
    expect(pickInternalTransferBearers([], 1)).toEqual([])
  })
})

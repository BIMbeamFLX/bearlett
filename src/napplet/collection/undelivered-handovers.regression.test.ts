import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  FRIEND,
  RANDOM_KEY,
  TestNutftMint,
  deviceWithCards,
  restoredAccount,
  secretOf
} from './harness'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23. On
 * d0b347a the list of handed-over cards read only the wallet on screen, so a
 * handover made from the device wallet vanished once the account's wallet was
 * shown, and its token, the only claim on that card, could never be passed on.
 */

describe('regression: handovers from the device wallet stay reachable', () => {
  it('are listed after a move and can be passed on', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2, 3])
    const before = phone.open()
    await before.session.open()
    const snap = await before.session.snapshot()
    const handed = await before.session.handOver(
      secretOf(snap.owned[0]),
      FRIEND
    )
    expect(await before.session.sent()).toHaveLength(1)

    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toMatchObject({
      active: 'random',
      migration: 'offer',
      cards: 2
    })
    expect(await ui.session.sent()).toHaveLength(1)
    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await ui.session.sent()).map(entry => entry.token)).toEqual([
      handed.token
    ])

    const again = phone.open(ACCOUNT_A)
    expect(await again.session.open()).toMatchObject({
      active: 'host',
      migration: 'none'
    })
    expect((await again.session.sent()).map(entry => entry.token)).toEqual([
      handed.token
    ])
    await again.session.passedOn([handed.token!])
    expect(await again.session.sent()).toEqual([])
    expect((await phone.state(RANDOM_KEY)).outgoing).toEqual([])
  })

  it('are listed under the account when the device wallet gave every card away', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1])
    const before = phone.open()
    await before.session.open()
    const snap = await before.session.snapshot()
    const handed = await before.session.handOver(
      secretOf(snap.owned[0]),
      FRIEND
    )
    expect((await phone.state(RANDOM_KEY)).tokens).toEqual([])

    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })
    expect((await ui.session.sent()).map(entry => entry.token)).toEqual([
      handed.token
    ])
  })
})

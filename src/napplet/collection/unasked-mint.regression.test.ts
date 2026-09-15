import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  MIGRATION_KEY,
  RANDOM_KEY,
  TestNutftMint,
  deviceWithCards,
  intercept,
  restoredAccount,
  unreachable
} from './harness'
import {MigrationStopped} from './migration'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23. On
 * d0b347a the card library's answer to a checkstate it could not make was a
 * snapshot with no cards, and the collection read that as a wallet without
 * cards: it switched wallets, moved nothing, and gave a card still held up as
 * gone. A mint that could not be asked is not an answer.
 */

describe('regression: a mint that could not be asked', () => {
  it('stops open() instead of hiding the device cards', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    const answer = unreachable(mint, 'checkstate')
    await expect(ui.session.open()).rejects.toThrow(/could not/)
    expect((await phone.state(RANDOM_KEY)).tokens.length).toBeGreaterThan(0)
    answer()
    expect(await ui.session.open()).toMatchObject({
      active: 'random',
      migration: 'offer',
      cards: 2
    })
  })

  it('plans no move and switches nothing', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toMatchObject({
      migration: 'offer',
      cards: 2
    })
    const answer = unreachable(mint, 'checkstate')
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)
    expect(ui.session.active).toBe('random')
    expect(phone.storage.map.has(MIGRATION_KEY)).toBe(false)
    answer()
    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
  })

  it('never gives a card that is still here up as gone', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    /* The mint refuses the first trade before changing anything, with a
       verdict: the library drops the pending, and the step stays trading. (A
       429 is no verdict any more; the library keeps the pending for it.) */
    let trades = 0
    const limiter = intercept(mint, async request =>
      request.operation === 'trade' && ++trades === 1
        ? {status: 400, body: '{"error":"not now"}'}
        : undefined
    )
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)
    limiter()
    expect((await phone.state(RANDOM_KEY)).pending).toBeFalsy()

    const answer = unreachable(mint, 'checkstate')
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)
    expect(ui.session.active).toBe('random')
    answer()
    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })

    /* Account B signs in afterwards: nothing is left behind to offer. */
    await restoredAccount(phone, ACCOUNT_B)
    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toMatchObject({
      active: 'host',
      migration: 'none'
    })
  })
})

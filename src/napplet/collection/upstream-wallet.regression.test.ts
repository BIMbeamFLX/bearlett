import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  TestNutftMint,
  device,
  deviceWithCards,
  intercept,
  rateLimit,
  restoredAccount
} from './harness'
import {MigrationStopped} from './migration'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23 that
 * only the card library itself can make pass. The fixes are being made
 * upstream, on TCG600nap branch fix/referee-rate-limits: a dropped pending no
 * longer burns counters, a restore scans at least 2N+100 counters, and a trade
 * stays pending on 429 or any 5xx whatever the body says. These are switched
 * on when src/napplet/collection/vendor/nutft-wallet.js is vendored again from
 * that branch.
 */

describe('regression: card library behaviour fixed upstream', () => {
  it.skip('a refused re-issue in a 300-card catalogue does not cut the restore short (TCG600nap fix/referee-rate-limits)', async () => {
    const mint = new TestNutftMint({cards: 300})
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    const address = await ui.session.destination()
    rateLimit(mint, 'trade', 2)
    for (const card of [99, 98, 97])
      expect(await ui.session.receive(mint.issue(address, card))).toBe(1)
    expect((await ui.session.snapshot()).owned).toHaveLength(3)

    const laptop = device(mint).open(ACCOUNT_A)
    await laptop.session.open()
    expect(await laptop.session.restore()).toBe(3)
  }, 600000)

  it.skip('a JSON error after the mint committed a trade keeps the move going (TCG600nap fix/referee-rate-limits)', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    let trades = 0
    intercept(mint, async (request, ask) => {
      if (request.operation !== 'trade' || ++trades !== 1) return undefined
      /* A gateway that answers in JSON after the mint ran the trade. */
      await ask(request)
      return {status: 504, body: '{"error":"upstream timed out"}'}
    })
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)
    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
  })
})

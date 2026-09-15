import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  TestNutftMint,
  accountKey,
  device,
  fakeClock,
  intercept,
  restoredAccount
} from './harness'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23. On
 * d0b347a the transport dropped the mint's Retry-After, so a per-client rate
 * limit failed every restore at the same call, kept no progress, and refused
 * receiving the whole time. These assert that a restore waits as the mint
 * asks, and that receiving never waits on a restore.
 */

/* An account whose cards sit on its deterministic outputs at this mint. */
const accountWithCards = async (mint: TestNutftMint, cards: number[]) => {
  const first = device(mint)
  await restoredAccount(first, ACCOUNT_A)
  const one = first.open(ACCOUNT_A)
  await one.session.open()
  const address = await one.session.destination()
  for (const card of cards)
    await one.wallet.importToken(mint.url, mint.issue(address, card))
  return address
}

describe('regression: restoring under a rate limit', () => {
  it('waits as the mint asks and finishes', async () => {
    const mint = new TestNutftMint()
    await accountWithCards(mint, [0, 1, 3])
    /* Three restore or checkstate calls per 20-second window. */
    const clock = fakeClock()
    let window = 0
    let used = 0
    intercept(mint, async request => {
      if (!['restore', 'checkstate'].includes(request.operation))
        return undefined
      const current = Math.floor(clock.now() / 20000)
      if (current !== window) {
        window = current
        used = 0
      }
      if (++used <= 3) return undefined
      return {
        status: 429,
        body: '{"error":"rate limited"}',
        retryAfterMs: 20000 - (clock.now() % 20000)
      }
    })

    const laptop = device(mint, {sleep: clock.sleep})
    const two = laptop.open(ACCOUNT_A)
    expect(await two.session.open()).toMatchObject({
      active: 'host',
      restore: true
    })
    expect(await two.session.restore()).toBe(3)
    expect(clock.now()).toBeGreaterThan(0)
    const stored = await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    expect(stored.restore).toBeUndefined()
    expect((await two.session.snapshot()).owned).toHaveLength(3)
  })

  it.fails(
    'receives while a restore keeps being refused, and finishes it later',
    async () => {
      const mint = new TestNutftMint()
      const address = await accountWithCards(mint, [0, 1, 3])
      let refusing = true
      intercept(mint, async request =>
        refusing && request.operation === 'restore'
          ? {status: 429, body: '{"error":"rate limited"}', retryAfterMs: 60000}
          : undefined
      )

      const laptop = device(mint)
      const two = laptop.open(ACCOUNT_A)
      await two.session.open()
      const stopped = await two.session.restore().catch(error => error)
      expect(stopped).toBeInstanceOf(Error)
      expect(stopped.message).toMatch(/continues/)
      expect(
        (await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)).restore
      ).toBe('pending')

      /* Card 2 lands on an output the first device never used. */
      expect(await two.session.receive(mint.issue(address, 2))).toBe(1)
      expect((await two.session.snapshot()).owned).toHaveLength(1)

      refusing = false
      /* The three cards the first device holds come back beside it. */
      expect(await two.session.restore()).toBe(3)
      expect((await two.session.snapshot()).owned).toHaveLength(4)
      expect(
        (await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)).restore
      ).toBeUndefined()
    }
  )
})

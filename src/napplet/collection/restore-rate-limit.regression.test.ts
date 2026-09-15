import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  TestNutftMint,
  accountKey,
  device,
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
 * asks, and that receiving never waits on a restore that gave up.
 *
 * The card library does the waiting for restore and checkstate itself, on its
 * own timers, so the clock here is Vitest's: it moves only as the test says.
 */

beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']})
})
afterEach(() => {
  vi.useRealTimers()
})

/* Let the fake clock run until the work is done, a second at a time. */
const run = async <T>(work: Promise<T>): Promise<T> => {
  let done = false
  work.then(
    () => (done = true),
    () => (done = true)
  )
  while (!done) await vi.advanceTimersByTimeAsync(1000)
  return work
}

/* An account whose cards sit on its deterministic outputs at this mint. */
const accountWithCards = async (mint: TestNutftMint, cards: number[]) => {
  const first = device(mint)
  await restoredAccount(first, ACCOUNT_A)
  const one = first.open(ACCOUNT_A)
  await run(one.session.open())
  const address = await run(one.session.destination())
  for (const card of cards)
    await run(one.wallet.importToken(mint.url, mint.issue(address, card)))
  return address
}

describe('regression: restoring under a rate limit', () => {
  it('waits as the mint asks and finishes', async () => {
    const mint = new TestNutftMint()
    await accountWithCards(mint, [0, 1, 3])
    /* The second and the fourth restore or checkstate call are refused, each
       with a wait of its own; every other call is answered. */
    let calls = 0
    const refusedAt: number[] = []
    const askedAt: number[] = []
    intercept(mint, async request => {
      if (!['restore', 'checkstate'].includes(request.operation))
        return undefined
      calls += 1
      askedAt.push(Date.now())
      if (calls !== 2 && calls !== 4) return undefined
      refusedAt.push(askedAt.length - 1)
      return {
        status: 429,
        body: '{"error":"rate limited"}',
        retryAfterMs: 5000
      }
    })

    const laptop = device(mint)
    const two = laptop.open(ACCOUNT_A)
    expect(await run(two.session.open())).toMatchObject({
      active: 'host',
      restore: true
    })
    expect(await run(two.session.restore())).toBe(3)
    expect(refusedAt).toHaveLength(2)
    /* Each refused call was asked again once, and not before the mint's wait. */
    for (const index of refusedAt)
      expect(askedAt[index + 1] - askedAt[index]).toBeGreaterThanOrEqual(5000)
    const stored = await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    expect(stored.restore).toBeUndefined()
    expect((await run(two.session.snapshot())).owned).toHaveLength(3)
  })

  it('receives while a restore keeps being refused, and finishes it later', async () => {
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
    await run(two.session.open())
    const stopped = await run(two.session.restore()).catch(error => error)
    expect(stopped).toBeInstanceOf(Error)
    expect(stopped.message).toMatch(/continues/)
    expect((await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)).restore).toBe(
      'pending'
    )

    /* Card 2 lands on an output the first device never used. */
    expect(await run(two.session.receive(mint.issue(address, 2)))).toBe(1)
    expect((await run(two.session.snapshot())).owned).toHaveLength(1)

    refusing = false
    /* The three cards the first device holds come back beside it. */
    expect(await run(two.session.restore())).toBe(3)
    expect((await run(two.session.snapshot())).owned).toHaveLength(4)
    expect(
      (await laptop.state(accountKey(ACCOUNT_A), ACCOUNT_A)).restore
    ).toBeUndefined()
  })
})

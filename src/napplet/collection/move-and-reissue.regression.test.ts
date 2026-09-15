import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  FRIEND,
  RANDOM_KEY,
  TestNutftMint,
  addressOf,
  device,
  deviceWithCards,
  lockedToAccount,
  rateLimit,
  refuseJournalAfterTrade,
  restoredAccount,
  secretOf
} from './harness'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the security review of pull request 23, first written
 * by nappelin-com-3e against d0b347a, where each of them lost or stranded a
 * card. They assert what must happen instead.
 */

describe('regression: a refused re-issue during a move (S1)', () => {
  it.fails(
    'confirms a moved card only once the seed can restore it',
    async () => {
      const mint = new TestNutftMint()
      const {phone} = await deviceWithCards(mint, [1])
      await restoredAccount(phone, ACCOUNT_A)
      /* The second trade is the account's re-issue, refused once with a JSON
       body before the mint changes anything, as a busy mint would. */
      rateLimit(mint, 'trade', 2)
      const a = phone.open(ACCOUNT_A)
      expect(await a.session.open()).toMatchObject({migration: 'offer'})
      const result = await a.session.migrate().catch(() => a.session.migrate())
      expect(result).toEqual({moved: 1, gone: 0, restored: null})
      expect(a.session.active).toBe('host')
      expect((await a.session.snapshot()).owned).toHaveLength(1)

      const laptop = device(mint).open(ACCOUNT_A)
      await laptop.session.open()
      expect(await laptop.session.restore()).toBe(1)
    }
  )
})

describe('regression: two devices on one account seed (B2)', () => {
  /* The card library derives the same NUT-13 output on both devices, and only
     a NUT-09 probe before every self re-issue can skip it. That probe is being
     added upstream, on TCG600nap branch fix/referee-rate-limits; this test is
     switched on when the library is vendored again from there. */
  it.skip('keeps each device on its own output (waits for the NUT-09 probe from TCG600nap fix/referee-rate-limits)', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const laptop = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    await restoredAccount(laptop, ACCOUNT_A)
    const p = phone.open(ACCOUNT_A)
    const l = laptop.open(ACCOUNT_A)
    await p.session.open()
    await l.session.open()
    const address = addressOf(ACCOUNT_A).pubkey
    expect(await p.session.receive(mint.issue(address, 1))).toBe(1)
    expect(await l.session.receive(mint.issue(address, 1))).toBe(1)
    const onPhone = (await p.session.snapshot()).owned.map(secretOf)
    const onLaptop = (await l.session.snapshot()).owned.map(secretOf)
    expect(onPhone).toHaveLength(1)
    expect(onLaptop).toHaveLength(1)
    expect(onPhone[0]).not.toBe(onLaptop[0])

    /* The phone hands its card over; the laptop's card is untouched. */
    await p.session.handOver(onPhone[0], addressOf(ACCOUNT_B).pubkey)
    expect((await l.session.snapshot()).owned).toHaveLength(1)
    const fresh = device(mint).open(ACCOUNT_A)
    await fresh.session.open()
    expect(await fresh.session.restore()).toBe(1)
  })
})

describe('regression: an interrupted move and "They were passed on" (B1)', () => {
  it.fails(
    'never offers the move token as a handover, and moves every card',
    async () => {
      const mint = new TestNutftMint()
      const {phone} = await deviceWithCards(mint, [1, 2])
      await restoredAccount(phone, ACCOUNT_A)
      /* The journal write right after the first trade fails once, as a closed
       window or a full quota would stop it. The trade itself has committed. */
      refuseJournalAfterTrade(phone.storage)

      const first = phone.open(ACCOUNT_A)
      expect(await first.session.open()).toMatchObject({
        migration: 'offer',
        cards: 2
      })
      await expect(first.session.migrate()).rejects.toThrow()

      const second = phone.open(ACCOUNT_A)
      expect(await second.session.open()).toMatchObject({
        active: 'random',
        migration: 'resume'
      })
      expect(await second.session.sent()).toEqual([])
      const move = (await phone.state(RANDOM_KEY)).outgoing
        .map((entry: {token: string}) => entry.token)
        .filter((token: string) => lockedToAccount(token))
      expect(move).toHaveLength(1)
      await expect(second.session.passedOn(move)).rejects.toThrow()

      expect(await second.session.migrate()).toEqual({
        moved: 2,
        gone: 0,
        restored: null
      })
      expect((await second.session.snapshot()).owned).toHaveLength(2)
      const random = await phone.state(RANDOM_KEY)
      expect(random.tokens).toEqual([])
      expect(random.outgoing).toEqual([])
    }
  )

  it.fails(
    'refuses a handover while the move is open, and strands no move token',
    async () => {
      const mint = new TestNutftMint()
      const {phone} = await deviceWithCards(mint, [1, 2, 3])
      await restoredAccount(phone, ACCOUNT_A)
      refuseJournalAfterTrade(phone.storage)
      const first = phone.open(ACCOUNT_A)
      await first.session.open()
      await expect(first.session.migrate()).rejects.toThrow()

      const second = phone.open(ACCOUNT_A)
      expect(await second.session.open()).toMatchObject({
        active: 'random',
        migration: 'resume'
      })
      const owned = (await second.session.snapshot()).owned
      expect(owned).toHaveLength(2)
      await expect(
        second.session.handOver(secretOf(owned[1]), FRIEND)
      ).rejects.toThrow(/mov/i)

      expect(await second.session.migrate()).toEqual({
        moved: 3,
        gone: 0,
        restored: null
      })
      expect((await second.session.snapshot()).owned).toHaveLength(3)
      const random = await phone.state(RANDOM_KEY)
      expect(
        random.outgoing.filter((entry: {token: string}) =>
          lockedToAccount(entry.token)
        )
      ).toEqual([])
    }
  )
})

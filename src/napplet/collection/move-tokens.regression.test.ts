import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  FRIEND,
  RANDOM_KEY,
  TestNutftMint,
  device,
  deviceWithCards,
  lockedToAccount,
  restoredAccount,
  secretOf
} from './harness'
import {MigrationStopped} from './migration'
import {ReceiveProblem} from './receive'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23. On
 * d0b347a a move found its own traded token by position in the device
 * wallet's sent list, listed it as a handover, and gave the card up as gone
 * when anything else changed that list. These assert the move's token is
 * found by its lock, and that nothing can drop it while the move is open.
 */

const moveTokens = async (phone: ReturnType<typeof device>, seed = ACCOUNT_A) =>
  ((await phone.state(RANDOM_KEY)).outgoing as Array<{token: string}>)
    .map(entry => entry.token)
    .filter(token => lockedToAccount(token, seed))

describe('regression: the move token in the device wallet', () => {
  it('(a) a lost answer: the token is not a handover, and "passed on" cannot drop it', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toMatchObject({
      active: 'random',
      migration: 'offer',
      cards: 2
    })
    /* The first trade commits at the mint; its answer is lost. */
    mint.lost = 'trade'
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)

    /* Try again refreshes, which finishes the pending trade. */
    await ui.session.snapshot()
    expect(await ui.session.sent()).toEqual([])
    const move = await moveTokens(phone)
    expect(move).toHaveLength(1)
    await expect(ui.session.passedOn(move)).rejects.toThrow()

    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect(ui.session.active).toBe('host')
    expect((await ui.session.snapshot()).owned).toHaveLength(2)
    const random = await phone.state(RANDOM_KEY)
    expect(random.tokens).toEqual([])
    expect(random.outgoing).toEqual([])
  })

  it('(b) no other card can be handed over while the move is open', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2, 3])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    mint.lost = 'trade'
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)

    const snap = await ui.session.snapshot()
    expect(snap.owned).toHaveLength(2)
    await expect(
      ui.session.handOver(secretOf(snap.owned[0]), FRIEND)
    ).rejects.toThrow(/mov/i)

    expect(await ui.session.migrate()).toEqual({
      moved: 3,
      gone: 0,
      restored: null
    })
    expect((await ui.session.snapshot()).owned).toHaveLength(3)
    expect(await moveTokens(phone)).toEqual([])
    const again = phone.open(ACCOUNT_A)
    expect(await again.session.open()).toMatchObject({
      active: 'host',
      migration: 'none'
    })
  })

  it('(c) another copy of the same card is never taken for the moved one', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    /* The account already holds one copy of card 1. */
    const acct = phone.open(ACCOUNT_A)
    expect(await acct.session.open()).toMatchObject({active: 'host'})
    const accountAddress = await acct.session.destination()
    await acct.wallet.importToken(mint.url, mint.issue(accountAddress, 1))
    /* The device wallet holds two more copies of it. */
    const old = phone.open()
    await old.session.open()
    const deviceAddress = await old.session.destination()
    await old.wallet.importToken(mint.url, mint.issue(deviceAddress, 1))
    await old.wallet.importToken(mint.url, mint.issue(deviceAddress, 1))

    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toMatchObject({
      active: 'random',
      migration: 'offer',
      cards: 2
    })
    mint.lost = 'trade'
    await expect(ui.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)
    const snap = await ui.session.snapshot()
    expect(snap.owned).toHaveLength(1)
    await expect(
      ui.session.handOver(secretOf(snap.owned[0]), FRIEND)
    ).rejects.toThrow(/mov/i)

    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect(ui.session.active).toBe('host')
    expect((await ui.session.snapshot()).owned).toHaveLength(3)
    expect(await ui.session.sent()).toEqual([])
    expect((await phone.state(RANDOM_KEY)).outgoing).toEqual([])
  })

  it('(d) another account and a signed-out open leave a stopped move alone', async () => {
    const mint = new TestNutftMint()
    const {phone, address} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    await restoredAccount(phone, ACCOUNT_B)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    mint.lost = 'trade'
    await expect(a.session.migrate()).rejects.toBeInstanceOf(MigrationStopped)

    /* Account B: its own wallet, and the move left exactly as it is. */
    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toMatchObject({
      active: 'host',
      migration: 'elsewhere'
    })
    await b.session.destination()
    await b.session.snapshot()
    expect(await b.session.sent()).toEqual([])

    /* Signed out: the device wallet, which may not give anything away. */
    const none = phone.open()
    expect(await none.session.open()).toMatchObject({
      active: 'random',
      migration: 'elsewhere'
    })
    expect(await none.session.destination()).toBe(address)
    const snap = await none.session.snapshot()
    expect(await none.session.sent()).toEqual([])
    const move = await moveTokens(phone)
    expect(move).toHaveLength(1)
    await expect(none.session.passedOn(move)).rejects.toThrow()
    await expect(
      none.session.handOver(secretOf(snap.owned[0]), FRIEND)
    ).rejects.toThrow(/mov/i)
    const refused = await none.session
      .receive(mint.issue(address, 3))
      .catch(error => error)
    expect(refused).toBeInstanceOf(ReceiveProblem)
    expect(refused.reason).toBe('moving')

    /* Account A again: the move resumes and every card arrives. */
    const back = phone.open(ACCOUNT_A)
    expect(await back.session.open()).toMatchObject({migration: 'resume'})
    expect(await back.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await back.session.snapshot()).owned).toHaveLength(2)
  })
})

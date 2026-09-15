import {describe, expect, it, vi} from 'vitest'
import {
  ACCOUNT_A,
  TestNutftMint,
  accountKey,
  addressOf,
  cardsToken,
  device,
  deviceWithCards,
  intercept,
  rateLimit,
  refuseWrite,
  restoredAccount
} from './harness'
import {sealedWith} from './sealed'

/* Restores and moves do real curve arithmetic on every card slot. */
vi.setConfig({testTimeout: 120_000})

/*
 * Regression tests from the "never lose a card" review of pull request 23. On
 * d0b347a a card counted as moved or received as soon as the account held any
 * proof of it, even the randomly blinded one the sender made, which no restore
 * from the seed can ever find. These assert that every card the collection
 * confirms comes back on a new device.
 */

const restoreElsewhere = async (mint: TestNutftMint) => {
  const laptop = device(mint).open(ACCOUNT_A)
  await laptop.session.open()
  return laptop.session.restore()
}

describe('regression: every confirmed card is restorable from the seed', () => {
  it.fails('a move whose re-issue is refused once', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    /* Trade 1 moves card 1 to the account; trade 2 is its re-issue. */
    rateLimit(mint, 'trade', 2)
    const result = await ui.session.migrate().catch(() => ui.session.migrate())
    expect(result).toEqual({moved: 2, gone: 0, restored: null})
    expect(ui.session.active).toBe('host')
    expect((await ui.session.snapshot()).owned).toHaveLength(2)
    expect(await restoreElsewhere(mint)).toBe(2)
  })

  it.fails(
    'a move interrupted between the import and the re-issue',
    async () => {
      const mint = new TestNutftMint()
      const {phone} = await deviceWithCards(mint, [1])
      await restoredAccount(phone, ACCOUNT_A)
      const ui = phone.open(ACCOUNT_A)
      await ui.session.open()
      /* The account wallet's write that starts the re-issue is refused once, as
       a full quota or a closed frame would stop it. */
      const key = accountKey(ACCOUNT_A)
      refuseWrite(phone.storage, key, async value =>
        Boolean(
          JSON.parse(await sealedWith(ACCOUNT_A).open(value, key)).pending
        )
      )
      const result = await ui.session
        .migrate()
        .catch(() => ui.session.migrate())
      expect(result).toEqual({moved: 1, gone: 0, restored: null})
      expect((await ui.session.snapshot()).owned).toHaveLength(1)
      expect(await restoreElsewhere(mint)).toBe(1)
    }
  )

  it('a three-card token whose second re-issue answer is lost', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    const token = cardsToken(mint, addressOf(ACCOUNT_A).pubkey, [0, 1, 2])
    let trades = 0
    const answer = intercept(mint, async request => {
      if (request.operation === 'trade' && ++trades === 2)
        throw new Error('Mint request unavailable, denied, or interrupted.')
      return undefined
    })
    expect(await ui.session.receive(token)).toBe(3)
    answer()
    expect((await ui.session.snapshot()).owned).toHaveLength(3)
    expect(await restoreElsewhere(mint)).toBe(3)
  })

  it('a three-card token whose second re-issue is refused', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    const token = cardsToken(mint, addressOf(ACCOUNT_A).pubkey, [0, 1, 2])
    rateLimit(mint, 'trade', 2)
    expect(await ui.session.receive(token)).toBe(3)
    expect((await ui.session.snapshot()).owned).toHaveLength(3)
    expect(await restoreElsewhere(mint)).toBe(3)
  })
})

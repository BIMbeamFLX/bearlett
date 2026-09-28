// A wallet with many cards stays quick and small (#41 review, N5): each
// card's history is checked once, not on every render, and the record of a
// card handed on is dropped after a week.
import {afterEach, describe, expect, it, vi} from 'vitest'
import * as proofs from '../../src/cards/proofs.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {memoryStore} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {Wallet} from '../../src/wallet/wallet.ts'
import {startCardMint, type CardMint} from './mint.ts'

vi.mock('../../src/cards/proofs.ts', async importOriginal => {
  const original = await importOriginal<typeof proofs>()
  return {...original, verifyConsignment: vi.fn(original.verifyConsignment)}
})

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})
const start = async (): Promise<CardMint> => {
  const mint = await startCardMint()
  closers.push(() => mint.close())
  return mint
}
const holder = async (mint: CardMint, now = () => Date.now()) => {
  const wallet = await Wallet.create(
    {net: fetchNet, store: memoryStore(), now},
    newMnemonic(),
    ''
  )
  const {domain} = await wallet.addCardMint(mint.url)
  return {wallet, domain}
}
const buyPack = async (mint: CardMint, wallet: Wallet, domain: string) => {
  const invoice = await wallet.requestPack(domain)
  await mint.settle(invoice.verify!)
  await wallet.refreshCards(domain)
}

describe('many cards', () => {
  it('are checked once each, not on every look', async () => {
    const mint = await start()
    const {wallet, domain} = await holder(mint)
    for (let pack = 0; pack < 3; pack++) await buyPack(mint, wallet, domain)
    const checks = vi.mocked(proofs.verifyConsignment)
    checks.mockClear()
    // what a render of the Cards tab and an inventory write do, many times
    for (let look = 0; look < 20; look++) {
      for (const card of wallet.cards({status: 'held'}))
        wallet.verifiedCard(card.id)
      wallet.inventory()
    }
    expect(wallet.cards({status: 'held'})).toHaveLength(9)
    expect(checks).not.toHaveBeenCalled()
  })

  it('drop the record of a card handed on a week ago', async () => {
    const mint = await start()
    let now = Date.now()
    const alice = await holder(mint, () => now)
    const bob = await holder(mint)
    await buyPack(mint, alice.wallet, alice.domain)
    const [card] = alice.wallet.cards({status: 'held'})
    await alice.wallet.sendCard(card.id, bob.wallet.cardAddress(bob.domain))
    await alice.wallet.refreshCards(alice.domain)
    expect(alice.wallet.snapshot.cards[card.id].status).toBe('sent')
    now += 8 * 24 * 3600 * 1000
    await alice.wallet.refreshCards(alice.domain)
    expect(alice.wallet.snapshot.cards[card.id]).toBeUndefined()
    expect(alice.wallet.cards({status: 'held'})).toHaveLength(2)
  })
})

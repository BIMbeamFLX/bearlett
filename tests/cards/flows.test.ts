// Bearlett's card flows end to end against the reference card mint over real
// HTTP: buying a pack, handing a card on, lost answers, recovery from the
// words, a card mint that lies, and the inventory the Hangar and the TCG read.
import {afterEach, describe, expect, it} from 'vitest'
import {buildInventory, INVENTORY_KEY} from '../../src/cards/inventory.ts'
import {ProtocolError, TransportError} from '../../src/lnurl/errors.ts'
import type {Net} from '../../src/lnurl/net.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {memoryStore, type Store} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {MintKeyChangedError, Wallet} from '../../src/wallet/wallet.ts'
import {startMint, walletAt} from '../wallet/harness.ts'
import {startCardMint, type CardMint, type CardMintOptions} from './mint.ts'

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const start = async (options: CardMintOptions = {}): Promise<CardMint> => {
  const mint = await startCardMint(options)
  closers.push(() => mint.close())
  return mint
}

const holder = async (
  mint: CardMint,
  setup: {words?: string; net?: Net; store?: Store} = {}
) => {
  const wallet = await Wallet.create(
    {net: setup.net ?? fetchNet, store: setup.store ?? memoryStore()},
    setup.words ?? newMnemonic(),
    ''
  )
  const {domain} = await wallet.addCardMint(mint.url)
  return {wallet, domain}
}

/** Buys a pack; the test hook stands in for paying its invoice. */
const buyPack = async (mint: CardMint, wallet: Wallet, domain: string) => {
  const invoice = await wallet.requestPack(domain)
  await mint.settle(invoice.verify!)
  await wallet.refreshCards(domain)
  return invoice
}

const names = (wallet: Wallet, status: 'held' | 'sent' = 'held') =>
  wallet
    .cards({status})
    .map(card => wallet.verifiedCard(card.id).head.name)
    .sort()

describe('buying a pack', () => {
  it('adds a card mint and pins its issuer', async () => {
    const mint = await start()
    const {wallet, domain} = await holder(mint)
    expect(wallet.cardMint(domain)).toMatchObject({
      withdraw: `${mint.url}/w`,
      lookup: `${mint.url}/cards`,
      packs: [{edition: '600b-e1', collection_id: '600B-E1'}]
    })
  })

  it('pays a fixed price, and the cards arrive at a fresh key of its own', async () => {
    const mint = await start()
    const {wallet, domain} = await holder(mint)
    const invoice = await wallet.requestPack(domain)
    expect(invoice.amountMsat).toBe(21_000)
    expect(invoice.pr).toMatch(/^lnbc210n1/)
    expect(await wallet.refreshCards(domain)).toBe(0)
    await mint.settle(invoice.verify!)
    expect(await wallet.refreshCards(domain)).toBe(3)
    expect(names(wallet)).toEqual(['E1-001', 'E1-042', 'E1-042'])
    // two copies of one card are two cards, with two serials
    const serials = wallet
      .cards()
      .map(card => wallet.verifiedCard(card.id).head.description)
      .sort()
    expect(serials).toEqual(['600B-E1#1', '600B-E1#1', '600B-E1#2'])
    expect(wallet.snapshot.activity[0].text).toBe('Received 3 cards')
  })

  it('pays the pack from its own balance at a sats mint', async () => {
    const mint = await start()
    const sats = await startMint({baseFeeMsat: 1000})
    closers.push(() => sats.close())
    const wallet = await walletAt(sats, 50_000)
    const {domain} = await wallet.addCardMint(mint.url)
    const invoice = await wallet.requestPack(domain)
    const satsMint = Object.keys(wallet.snapshot.mints)[0]
    await wallet.pay(satsMint, invoice.pr)
    await wallet.settle()
    // 49 sat, less 21 for the pack and 1 for splitting it off
    expect(wallet.balanceMsat()).toBe(27_000)
    await mint.settle(invoice.verify!)
    await wallet.refreshCards(domain)
    expect(wallet.cards({status: 'held'})).toHaveLength(3)
  })
})

describe('handing a card on', () => {
  it('moves a card to another holder’s card address', async () => {
    const mint = await start()
    const alice = await holder(mint)
    const bob = await holder(mint)
    await buyPack(mint, alice.wallet, alice.domain)
    const [card] = alice.wallet.cards({status: 'held'})
    const name = alice.wallet.verifiedCard(card.id).head.name
    await alice.wallet.sendCard(
      card.id,
      await bob.wallet.cardAddress(bob.domain)
    )
    expect(alice.wallet.cards({status: 'held'})).toHaveLength(2)
    expect(alice.wallet.snapshot.cards[card.id].status).toBe('sent')
    expect(await bob.wallet.refreshCards(bob.domain)).toBe(1)
    const atBob = bob.wallet.verifiedCard(card.id)
    expect(atBob.head.name).toBe(name)
    expect(atBob.states).toHaveLength(2)
    // and on again, back to alice
    await bob.wallet.sendCard(
      card.id,
      await alice.wallet.cardAddress(alice.domain)
    )
    await alice.wallet.refreshCards(alice.domain)
    expect(alice.wallet.verifiedCard(card.id).states).toHaveLength(3)
    expect(alice.wallet.cards({status: 'held'})).toHaveLength(3)
  })

  it('asks again after a lost answer, and the card moves once', async () => {
    const mint = await start()
    let lose = 1
    const net: Net = {
      async get(url, options) {
        const body = await fetchNet.get(url, options)
        if (new URL(url).pathname === '/w/cb' && lose-- > 0)
          throw new TransportError('The answer was lost.')
        return body
      }
    }
    const alice = await holder(mint, {net})
    const bob = await holder(mint)
    await buyPack(mint, alice.wallet, alice.domain)
    const [card] = alice.wallet.cards({status: 'held'})
    const to = await bob.wallet.cardAddress(bob.domain)
    await expect(alice.wallet.sendCard(card.id, to)).rejects.toBeInstanceOf(
      TransportError
    )
    expect(alice.wallet.snapshot.cards[card.id].status).toBe('moving')
    await alice.wallet.settle()
    expect(alice.wallet.snapshot.cards[card.id].status).toBe('sent')
    expect(await bob.wallet.refreshCards(bob.domain)).toBe(1)
    expect(bob.wallet.verifiedCard(card.id).states).toHaveLength(2)
  })

  it('refuses to move a card it does not hold, or to no key', async () => {
    const mint = await start()
    const alice = await holder(mint)
    await buyPack(mint, alice.wallet, alice.domain)
    const [card] = alice.wallet.cards({status: 'held'})
    await expect(alice.wallet.sendCard(card.id, 'lnbc1')).rejects.toThrow(/cp1/)
    await expect(alice.wallet.sendCard('00'.repeat(32), 'cp1')).rejects.toThrow(
      /holds/
    )
    expect(alice.wallet.cards({status: 'held'})).toHaveLength(3)
  })
})

describe('the words alone', () => {
  it('bring every card back', async () => {
    const mint = await start()
    const words = newMnemonic()
    const alice = await holder(mint, {words})
    await buyPack(mint, alice.wallet, alice.domain)
    await buyPack(mint, alice.wallet, alice.domain)
    const restored = await holder(mint, {words})
    expect(await restored.wallet.refreshCards(restored.domain, true)).toBe(6)
    expect(names(restored.wallet)).toEqual(names(alice.wallet))
    // the next key it hands out is past the ones in use
    const next = await restored.wallet.cardAddress(restored.domain)
    expect(await alice.wallet.cardAddress(alice.domain)).toBe(next)
  })
})

describe('a card mint that lies', () => {
  it('is not trusted with a card whose history does not verify', async () => {
    const mint = await start()
    const alice = await holder(mint)
    await buyPack(mint, alice.wallet, alice.domain)
    const lying: Net = {
      async get(url, options) {
        const body = await fetchNet.get(url, options)
        if (new URL(url).pathname !== '/cards') return body
        const cards = (body.cards as {genesis: string}[]).map(card => ({
          ...card,
          genesis: card.genesis.replace(/^./, c => (c === '0' ? '1' : '0'))
        }))
        return {...body, cards}
      }
    }
    const words = newMnemonic()
    const bob = await holder(mint, {words, net: lying})
    await buyPack(mint, alice.wallet, alice.domain)
    const [card] = alice.wallet.cards({status: 'held'})
    await alice.wallet.sendCard(
      card.id,
      await bob.wallet.cardAddress(bob.domain)
    )
    await expect(bob.wallet.refreshCards(bob.domain)).rejects.toBeInstanceOf(
      ProtocolError
    )
    expect(bob.wallet.cards()).toEqual([])
  })

  it('may not change its issuer key', async () => {
    const mint = await start()
    let swap = false
    const net: Net = {
      async get(url, options) {
        const body = await fetchNet.get(url, options)
        return swap && url.endsWith('/.well-known/lnurlcash-cards')
          ? {
              ...body,
              issuer:
                'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
            }
          : body
      }
    }
    const {wallet} = await holder(mint, {net})
    swap = true
    await expect(wallet.addCardMint(mint.url)).rejects.toBeInstanceOf(
      MintKeyChangedError
    )
  })
})

// nappelin apps/hangar/src/inventory.ts parseInventory (origin/main
// c65e98dd, 2026-09-27), condensed: the strictest reader of the payload
const hangarAccepts = (value: unknown): boolean => {
  const top = value as Record<string, unknown>
  const keys = [
    'v',
    'kind',
    'edition',
    'collection_id',
    'catalog_uri',
    'mint',
    'at',
    'cards'
  ]
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  const https = (url: unknown) => {
    try {
      const u = new URL(String(url))
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        String(url).length <= 2048
      )
    } catch {
      return false
    }
  }
  if (
    !top ||
    typeof top !== 'object' ||
    Object.keys(top).length !== keys.length
  )
    return false
  if (
    !keys.every(key => key in top) ||
    top.v !== 1 ||
    top.kind !== 'nutft/inventory'
  )
    return false
  if (!name.test(String(top.edition)) || !name.test(String(top.collection_id)))
    return false
  if (top.catalog_uri !== '' && !https(top.catalog_uri)) return false
  if (
    !https(top.mint) ||
    !Number.isSafeInteger(top.at) ||
    (top.at as number) < 0
  )
    return false
  const cards = top.cards as {asset_id: string; count: number}[]
  if (!Array.isArray(cards) || cards.length > 4096) return false
  return cards.every(
    (card, i) =>
      Object.keys(card).length === 2 &&
      name.test(card.asset_id) &&
      Number.isSafeInteger(card.count) &&
      card.count >= 1 &&
      (i === 0 || cards[i - 1].asset_id < card.asset_id)
  )
}

describe('the inventory the Hangar answers the TCG with', () => {
  const pack = {edition: '600b-e1', collection_id: '600B-E1', catalog_uri: ''}

  it('counts cards by their id, in the shape the Hangar accepts', () => {
    const inventory = buildInventory(
      pack,
      'https://tcg.nappelin.com',
      ['E1-042', 'E1-001', 'E1-042', 'a', 'B'],
      1_790_000_000_123
    )
    expect(inventory).toEqual({
      v: 1,
      kind: 'nutft/inventory',
      edition: '600b-e1',
      collection_id: '600B-E1',
      catalog_uri: '',
      mint: 'https://tcg.nappelin.com',
      at: 1_790_000_000,
      cards: [
        {asset_id: 'B', count: 1},
        {asset_id: 'E1-001', count: 1},
        {asset_id: 'E1-042', count: 2},
        {asset_id: 'a', count: 1}
      ]
    })
    expect(hangarAccepts(inventory)).toBe(true)
    expect(
      hangarAccepts(buildInventory(pack, 'https://tcg.nappelin.com', [], 0))
    ).toBe(true)
  })

  it('writes nothing the Hangar would refuse', () => {
    expect(buildInventory(pack, 'http://127.0.0.1:1', ['E1-001'], 0)).toBeNull()
    expect(
      buildInventory(
        {...pack, edition: 'no spaces'},
        'https://a.example',
        [],
        0
      )
    ).toBeNull()
    expect(
      buildInventory(pack, 'https://a.example', ['E1-001', ' spaced'], 0)?.cards
    ).toEqual([{asset_id: 'E1-001', count: 1}])
  })

  it('is stored for the Hangar once cards change, when the mint is https', async () => {
    const mint = await start()
    const store = memoryStore()
    const alice = await holder(mint, {store})
    await buyPack(mint, alice.wallet, alice.domain)
    // the reference mint is plain http on this machine: nothing to show
    expect(await store.get(INVENTORY_KEY)).toBeNull()
    expect(alice.wallet.inventory()).toBeNull()
  })
})

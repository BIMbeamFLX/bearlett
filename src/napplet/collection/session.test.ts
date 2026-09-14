import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import * as cashu from '@cashu/cashu-ts'
import * as bip39 from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey} from '@scure/bip32'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {UNSAFE_OPEN_MESSAGE} from '../../host/nutft-contract'
import type {NutftOperation} from '../../host/nutft-contract'
import {prepareCollectionGlobals} from './bootstrap'
import type {NutFTWalletApi} from './bootstrap'
import {TestNutftMint} from './fixture'
import {MigrationStopped} from './migration'
import {sealedWith} from './sealed'
import {STILL_RESTORING, openSession} from './session'
import {
  WalletUnreadable,
  createWalletSlots,
  createWalletStore,
  storageKeyFor
} from './wallets'

const VENDOR = fileURLToPath(
  new URL('./vendor/nutft-wallet.js', import.meta.url)
)
const LIBRARY = readFileSync(VENDOR, 'utf8')
const crypto = {...bip39, wordlist, HDKey}
const ACCOUNT_A = '5e'.repeat(32)
const ACCOUNT_B = '6f'.repeat(32)
const RANDOM_KEY = 'bearlett:nutft:600b-e1'

const fingerprint = (seed: string) =>
  createHash('sha256')
    .update(`bearlett:nutft:fingerprint:${seed}`)
    .digest('hex')
    .slice(0, 16)
const accountKey = (seed: string) => `${RANDOM_KEY}:${fingerprint(seed)}`

/* The account's address, derived here without the collection's own code. */
const addressOf = (seed: string) => {
  const words = bip39.entropyToMnemonic(hexToBytes(seed), wordlist)
  const key = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(words)).derive(
    "m/129373'/10'/0'/0'/0"
  ).privateKey!
  return {
    words,
    privateKey: bytesToHex(key),
    pubkey: bytesToHex(cashu.getPubKeyFromPrivKey(key))
  }
}

/* Every console method: nothing on these paths may write to any of them. */
let logged: unknown[][]
beforeEach(() => {
  logged = []
  for (const method of [
    'log',
    'info',
    'warn',
    'error',
    'debug',
    'trace'
  ] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
})
afterEach(() => {
  vi.restoreAllMocks()
  expect(logged).toEqual([])
})

const memory = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value)
    }
  }
}

/**
 * One device: the shell's storage, kept across opens. Each open is a fresh
 * realm with the vendored library loaded for real, the way a napplet reload
 * starts over with only what the shell kept.
 */
const device = (
  mint: TestNutftMint,
  storage = memory(),
  observe?: (operation: NutftOperation) => void
) => ({
  storage,
  open(seed?: string) {
    const edition = {
      id: '600b-e1',
      mint: mint.url,
      units: [mint.unit],
      mirrors: []
    }
    const store = createWalletStore(storage)
    const slots = createWalletSlots(store, storageKeyFor(edition))
    const scope: Record<string, unknown> = {
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      URL,
      setTimeout,
      clearTimeout,
      console,
      btoa: (value: string) => globalThis.btoa(value)
    }
    prepareCollectionGlobals(scope, edition, {
      storage: slots.port,
      nutft: mint,
      resource: {bytes: vi.fn()},
      cashu,
      walletCrypto: crypto,
      observe
    })
    const context = vm.createContext(scope)
    context.globalThis = context
    vm.runInContext(LIBRARY, context, {filename: VENDOR})
    const wallet = context.NutFTWallet as NutFTWalletApi
    return {
      wallet,
      session: openSession({edition, store, slots, wallet, cashu, crypto, seed})
    }
  },
  /** A stored wallet, opened with the account's seed when it is sealed. */
  async state(key: string, seed?: string) {
    const text = storage.map.get(key)
    if (!text) return null
    return JSON.parse(seed ? await sealedWith(seed).open(text, key) : text)
  },
  async store(key: string, value: unknown, seed?: string) {
    const text = JSON.stringify(value)
    storage.map.set(key, seed ? await sealedWith(seed).seal(text, key) : text)
  }
})

/* An account wallet at a mint that has never seen it has nothing to restore;
   the tests that are not about restoring skip that minute of arithmetic. */
const markRestored = async (phone: ReturnType<typeof device>, seed: string) => {
  const {restore, ...state} = await phone.state(accountKey(seed), seed)
  expect(restore).toBe('pending')
  await phone.store(accountKey(seed), state, seed)
}

describe('a collection without an account seed', () => {
  it('keeps the random wallet, and records that it is random', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session} = phone.open()
    expect(await session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'none',
      cards: 0
    })
    const address = await session.destination()
    const stored = await phone.state(RANDOM_KEY)
    expect(stored.pubkey).toBe(address)
    expect(stored.seedSource).toBe('random')
    expect(stored.seedPhrase.split(' ')).toHaveLength(12)
    expect([...phone.storage.map.keys()]).toEqual([RANDOM_KEY])
  })
})

describe('a collection with an account seed', () => {
  it('opens the account wallet under its fingerprint, on the seed key', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'none',
      cards: 0
    })
    const {pubkey, words} = addressOf(ACCOUNT_A)
    expect(await phone.state(accountKey(ACCOUNT_A), ACCOUNT_A)).toMatchObject({
      pubkey,
      seedSource: 'host',
      restore: 'pending',
      tokens: []
    })
    expect(await session.destination()).toBe(pubkey)
    /* No random wallet is made, and no key names the seed. */
    expect([...phone.storage.map.keys()]).toEqual([accountKey(ACCOUNT_A)])
    /* At rest the account wallet is sealed: no key, no word, no seed. */
    const sealed = phone.storage.map.get(accountKey(ACCOUNT_A))!
    for (const secret of [pubkey, ACCOUNT_A, words.split(' ')[0] + ' '])
      expect(sealed).not.toContain(secret)
    expect(JSON.parse(sealed)).toMatchObject({v: 1, alg: 'A256GCM'})
  })

  it('refuses an account wallet stored in the clear', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const first = phone.open(ACCOUNT_A)
    await first.session.open()
    const clear = await phone.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    await phone.store(accountKey(ACCOUNT_A), clear)
    const {session} = phone.open(ACCOUNT_A)
    await expect(session.open()).rejects.toThrow(WalletUnreadable)
  })

  it('restores the account cards on a new device, words never shown', async () => {
    const mint = new TestNutftMint()
    const first = device(mint)
    const one = first.open(ACCOUNT_A)
    await one.session.open()
    await markRestored(first, ACCOUNT_A)
    const address = await one.session.destination()
    /* Imported cards are re-issued to the account's own deterministic
       outputs, which is what makes them restorable from the seed. */
    expect(await one.wallet.importToken(mint.url, mint.issue(address, 2))).toBe(
      1
    )
    expect(await one.wallet.importToken(mint.url, mint.issue(address, 0))).toBe(
      1
    )
    expect((await one.session.snapshot()).owned).toHaveLength(2)

    const operations: NutftOperation[] = []
    const second = device(mint, memory(), operation =>
      operations.push(operation)
    )
    const two = second.open(ACCOUNT_A)
    expect(await two.session.open()).toMatchObject({
      active: 'host',
      restore: true
    })
    expect(await two.session.restore()).toBe(2)
    /* Progress can be counted from the restore batches the mint answers. */
    expect(
      operations.filter(name => name === 'restore').length
    ).toBeGreaterThan(2)
    const restored = await second.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    /* The library derived the key again on its own and landed on ours. */
    expect(restored.pubkey).toBe(address)
    expect(restored.seedSource).toBe('host')
    expect(restored.restore).toBeUndefined()
    expect((await two.session.snapshot()).owned).toHaveLength(2)
    expect(await two.session.restore()).toBeNull()
  }, 60000)

  it('gives a second account its own wallet and leaves the first alone', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    await markRestored(phone, ACCOUNT_A)
    const addressA = await a.session.destination()
    await a.wallet.importToken(mint.url, mint.issue(addressA, 1))
    const before = phone.storage.map.get(accountKey(ACCOUNT_A))

    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'none',
      cards: 0
    })
    expect(await b.session.destination()).toBe(addressOf(ACCOUNT_B).pubkey)
    expect(phone.storage.map.get(accountKey(ACCOUNT_A))).toBe(before)
    expect(
      (await phone.state(accountKey(ACCOUNT_B), ACCOUNT_B)).tokens
    ).toEqual([])
    /* Account B cannot even open account A's wallet. */
    await expect(phone.state(accountKey(ACCOUNT_A), ACCOUNT_B)).rejects.toThrow(
      WalletUnreadable
    )
  })

  it('keeps the random wallet on screen while it still holds cards', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const old = phone.open()
    await old.session.open()
    const address = await old.session.destination()
    await old.wallet.importToken(mint.url, mint.issue(address, 3))

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: true,
      migration: 'offer',
      cards: 1
    })
    expect(await session.destination()).toBe(address)
    expect((await session.snapshot()).owned).toHaveLength(1)
    /* Nothing is created for the account until the cards are moved. */
    expect(phone.storage.map.has(accountKey(ACCOUNT_A))).toBe(false)
  })

  it('refuses an account wallet that does not hold the seed key', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const other = addressOf(ACCOUNT_B)
    await phone.store(
      accountKey(ACCOUNT_A),
      {
        privateKey: '77'.repeat(32),
        pubkey: other.pubkey,
        seedPhrase: other.words,
        counters: {},
        tokens: [],
        seedSource: 'host'
      },
      ACCOUNT_A
    )
    const {session} = phone.open(ACCOUNT_A)
    await expect(session.open()).rejects.toThrow(UNSAFE_OPEN_MESSAGE)
    await expect(session.destination()).rejects.toThrow()
  })

  it('does not hand over from an account wallet still being restored', async () => {
    const mint = new TestNutftMint()
    const {session} = device(mint).open(ACCOUNT_A)
    await session.open()
    await expect(
      session.handOver('a secret', addressOf(ACCOUNT_B).pubkey)
    ).rejects.toThrow(STILL_RESTORING)
    expect(mint.calls.filter(call => call.operation === 'trade')).toEqual([])
  })

  it('refuses a seed that is not 64 lowercase hex before anything opens', () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    for (const seed of ['', ACCOUNT_A.toUpperCase(), ACCOUNT_A.slice(1)])
      expect(() => phone.open(seed)).toThrow(UNSAFE_OPEN_MESSAGE)
  })
})

describe('a card re-issued to itself when the answer was lost', () => {
  it('is taken back in instead of sitting among the sent transfers', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session, wallet} = phone.open()
    await session.open()
    const address = await session.destination()
    /* The re-issue trade commits at the mint and its answer never arrives. */
    mint.lost = 'trade'
    expect(await wallet.importToken(mint.url, mint.issue(address, 1))).toBe(1)
    expect((await phone.state(RANDOM_KEY)).pending).toBeTruthy()

    const snapshot = await session.snapshot()
    expect(snapshot.owned).toHaveLength(1)
    const state = await phone.state(RANDOM_KEY)
    expect(state.pending).toBeFalsy()
    expect(state.outgoing).toEqual([])
    expect(state.tokens).toHaveLength(1)
  })
})

/* A device that has used the collection before account seeds existed. */
const deviceWithCards = async (mint: TestNutftMint, cards: number[]) => {
  const phone = device(mint)
  const old = phone.open()
  await old.session.open()
  const address = await old.session.destination()
  for (const card of cards)
    await old.wallet.importToken(mint.url, mint.issue(address, card))
  return {phone, address}
}

/* The account wallet as a device that already restored it would hold it. */
const restoredAccount = async (
  phone: ReturnType<typeof device>,
  seed: string
) => {
  const {words, pubkey, privateKey} = addressOf(seed)
  await phone.store(
    accountKey(seed),
    {
      privateKey,
      pubkey,
      seedPhrase: words,
      counters: {},
      tokens: [],
      outgoing: [],
      pending: null,
      seedSource: 'host'
    },
    seed
  )
}

const MIGRATION_KEY = `${RANDOM_KEY}:migration`

describe('moving the device cards to the account', () => {
  it('moves them, switches after confirming, and a new device restores them', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 3])

    /* Record the order of journal writes and mint trades. */
    const order: string[] = []
    const write = phone.storage.setItem
    phone.storage.setItem = async (key, value) => {
      if (key === MIGRATION_KEY) order.push('journal')
      return write(key, value)
    }
    const ask = mint.request.bind(mint)
    mint.request = async request => {
      if (request.operation === 'trade') order.push('trade')
      return ask(request)
    }

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: true,
      migration: 'offer',
      cards: 2
    })
    const progress: string[] = []
    expect(
      await session.migrate((done, total) => progress.push(`${done}/${total}`))
    ).toEqual({moved: 2, gone: 0, restored: 0})
    expect(progress).toEqual(['1/2', '2/2'])
    expect(session.active).toBe('host')
    expect(order[0]).toBe('journal')
    expect(order.indexOf('journal')).toBeLessThan(order.indexOf('trade'))

    expect(await session.destination()).toBe(addressOf(ACCOUNT_A).pubkey)
    expect((await session.snapshot()).owned).toHaveLength(2)
    expect((await phone.state(RANDOM_KEY)).tokens).toEqual([])
    /* A finished move leaves no journal and no token behind. */
    expect(JSON.parse(phone.storage.map.get(MIGRATION_KEY)!)).toEqual({
      v: 1,
      to: fingerprint(ACCOUNT_A),
      finished: true
    })

    /* The next open shows the account wallet and offers nothing. */
    const again = phone.open(ACCOUNT_A)
    expect(await again.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })

    /* And the account's key image brings the moved cards back elsewhere. */
    const laptop = device(mint)
    const elsewhere = laptop.open(ACCOUNT_A)
    await elsewhere.session.open()
    expect(await elsewhere.session.restore()).toBe(2)
  }, 60000)

  it('resumes a move that stopped when the window closed', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [0, 2])
    await restoredAccount(phone, ACCOUNT_A)

    const first = phone.open(ACCOUNT_A)
    expect(await first.session.open()).toMatchObject({migration: 'offer'})
    /* The first trade commits at the mint; its answer never arrives. */
    mint.lost = 'trade'
    const stopped = await first.session.migrate().catch(error => error)
    expect(stopped).toBeInstanceOf(MigrationStopped)
    expect(stopped.message).not.toMatch(/cashu|nonce|P2PK/)
    expect(first.session.active).toBe('random')
    /* The journal names the account, and keeps the rest sealed. */
    const record = JSON.parse(phone.storage.map.get(MIGRATION_KEY)!)
    expect(record.to).toBe(fingerprint(ACCOUNT_A))
    expect(record.box).not.toMatch(/cashu|trading|nonce/)

    const second = phone.open(ACCOUNT_A)
    expect(await second.session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'resume',
      cards: 2
    })
    expect(await second.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await second.session.snapshot()).owned).toHaveLength(2)
    expect((await phone.state(RANDOM_KEY)).tokens).toEqual([])
  })

  it('never moves one account wallet into another', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    const addressA = await a.session.destination()
    await a.wallet.importToken(mint.url, mint.issue(addressA, 1))
    const before = phone.storage.map.get(accountKey(ACCOUNT_A))

    await restoredAccount(phone, ACCOUNT_B)
    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })
    expect(await b.session.migrate()).toEqual({
      moved: 0,
      gone: 0,
      restored: null
    })
    expect(phone.storage.map.get(accountKey(ACCOUNT_A))).toBe(before)
    expect((await b.session.snapshot()).owned).toEqual([])
    expect(mint.calls.filter(call => call.operation === 'trade')).toHaveLength(
      1
    )
  })

  it('leaves a move toward another account alone', async () => {
    const mint = new TestNutftMint()
    const {phone, address} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    mint.before = 'trade'
    await expect(a.session.migrate()).rejects.toThrow(MigrationStopped)
    const journal = phone.storage.map.get(MIGRATION_KEY)
    const random = phone.storage.map.get(RANDOM_KEY)

    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'elsewhere',
      cards: 0
    })
    await expect(b.session.migrate()).rejects.toThrow(/another account/)
    expect(phone.storage.map.get(MIGRATION_KEY)).toBe(journal)
    expect(phone.storage.map.get(RANDOM_KEY)).toBe(random)

    /* Without any seed the device wallet stays on screen, and says why the
       move is not offered. */
    const none = phone.open()
    expect(await none.session.open()).toMatchObject({
      active: 'random',
      migration: 'elsewhere'
    })
    expect(await none.session.destination()).toBe(address)
  })
})

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
import {STILL_RESTORING, openSession} from './session'
import {createWalletSlots, createWalletStore, storageKeyFor} from './wallets'

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
  return {words, pubkey: bytesToHex(cashu.getPubKeyFromPrivKey(key))}
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
  state(key: string) {
    const text = storage.map.get(key)
    return text ? JSON.parse(text) : null
  }
})

/* An account wallet at a mint that has never seen it has nothing to restore;
   the tests that are not about restoring skip that minute of arithmetic. */
const markRestored = (phone: ReturnType<typeof device>, seed: string) => {
  const {restore, ...state} = phone.state(accountKey(seed))
  expect(restore).toBe('pending')
  phone.storage.map.set(accountKey(seed), JSON.stringify(state))
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
    const stored = phone.state(RANDOM_KEY)
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
    const {pubkey} = addressOf(ACCOUNT_A)
    expect(phone.state(accountKey(ACCOUNT_A))).toMatchObject({
      pubkey,
      seedSource: 'host',
      restore: 'pending',
      tokens: []
    })
    expect(await session.destination()).toBe(pubkey)
    /* No random wallet is made, and no key names the seed. */
    expect([...phone.storage.map.keys()]).toEqual([accountKey(ACCOUNT_A)])
  })

  it('restores the account cards on a new device, words never shown', async () => {
    const mint = new TestNutftMint()
    const first = device(mint)
    const one = first.open(ACCOUNT_A)
    await one.session.open()
    markRestored(first, ACCOUNT_A)
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
    const restored = second.state(accountKey(ACCOUNT_A))
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
    markRestored(phone, ACCOUNT_A)
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
    expect(phone.state(accountKey(ACCOUNT_B)).tokens).toEqual([])
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
    phone.storage.map.set(
      accountKey(ACCOUNT_A),
      JSON.stringify({
        privateKey: '77'.repeat(32),
        pubkey: other.pubkey,
        seedPhrase: other.words,
        counters: {},
        tokens: [],
        seedSource: 'host'
      })
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
    expect(phone.state(RANDOM_KEY).pending).toBeTruthy()

    const snapshot = await session.snapshot()
    expect(snapshot.owned).toHaveLength(1)
    const state = phone.state(RANDOM_KEY)
    expect(state.pending).toBeFalsy()
    expect(state.outgoing).toEqual([])
    expect(state.tokens).toHaveLength(1)
  })
})

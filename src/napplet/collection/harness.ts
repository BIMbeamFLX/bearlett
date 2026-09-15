import {vi} from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import * as cashu from '@cashu/cashu-ts'
import * as bip39 from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey} from '@scure/bip32'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import type {NutftOperation, NutftRequest} from '../../host/nutft-contract'
import {prepareCollectionGlobals} from './bootstrap'
import type {CollectionEdition, NutFTWalletApi} from './bootstrap'
import {TestNutftMint} from './fixture'
import {sealedWith} from './sealed'
import {openSession} from './session'
import {createWalletSlots, createWalletStore, storageKeyFor} from './wallets'

/**
 * Test harness for the collection: devices, accounts and a mint that can be
 * made to misbehave. Imported only by tests; nothing in the napplet uses it.
 *
 * A device is the shell's storage, kept across opens. Each open is a fresh
 * realm with the vendored card library loaded for real, the way a napplet
 * reload starts over with only what the shell kept.
 */

const VENDOR = fileURLToPath(
  new URL('./vendor/nutft-wallet.js', import.meta.url)
)
const LIBRARY = readFileSync(VENDOR, 'utf8')

export const walletCrypto = {...bip39, wordlist, HDKey}
export const ACCOUNT_A = '5e'.repeat(32)
export const ACCOUNT_B = '6f'.repeat(32)
export const EDITION_ID = '600b-e1'
export const RANDOM_KEY = `bearlett:nutft:${EDITION_ID}`
export const MIGRATION_KEY = `${RANDOM_KEY}:migration`

export {TestNutftMint, cashu}

export const fingerprint = (seed: string): string =>
  createHash('sha256')
    .update(`bearlett:nutft:fingerprint:${seed}`)
    .digest('hex')
    .slice(0, 16)

export const accountKey = (seed: string): string =>
  `${RANDOM_KEY}:${fingerprint(seed)}`

/**
 * An account's key and address, derived here from the documented recipe and
 * not from the collection's own code: the seed's 32 bytes as 24 words, the key
 * on the card library's path.
 */
export const addressOf = (seed: string) => {
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

/** A key nobody in the test holds, for handing cards away. */
export const FRIEND = bytesToHex(
  cashu.getPubKeyFromPrivKey(hexToBytes('7a'.repeat(32)))
)

/** Whether every proof of a token is locked to this private key. */
export const lockedTo = (token: string, privateKey: string): boolean =>
  cashu
    .getTokenMetadata(token)
    .incompleteProofs.every(
      proof =>
        cashu.maybeDeriveP2BKPrivateKeys(privateKey, proof as never).length > 0
    )

export const lockedToAccount = (token: string, seed = ACCOUNT_A): boolean =>
  lockedTo(token, addressOf(seed).privateKey)

export type Storage = {
  map: Map<string, string>
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export const memory = (): Storage => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: async key => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value)
    }
  }
}

/** A clock whose sleeps pass at once and are added up. */
export const fakeClock = () => {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    }
  }
}

export type DeviceOptions = {
  storage?: Storage
  /** The edition this device's collection is built for; Edition One unless set. */
  edition?: string
  observe?: (operation: NutftOperation, detail?: {retryInMs?: number}) => void
  /** On unless a test builds the alpha collection. */
  accountWallets?: boolean
  /** How the transport waits before it asks the mint again. */
  sleep?: (ms: number) => Promise<void>
}

export const device = (mint: TestNutftMint, options: DeviceOptions = {}) => {
  const storage = options.storage ?? memory()
  return {
    storage,
    open(seed?: string) {
      const edition: CollectionEdition = {
        id: options.edition ?? EDITION_ID,
        mint: mint.url,
        units: [mint.unit],
        mirrors: [],
        accountWallets: options.accountWallets ?? true
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
        walletCrypto,
        observe: options.observe,
        sleep: options.sleep ?? (async () => {})
      })
      const context = vm.createContext(scope)
      context.globalThis = context
      vm.runInContext(LIBRARY, context, {filename: VENDOR})
      const wallet = context.NutFTWallet as NutFTWalletApi
      return {
        wallet,
        edition,
        session: openSession({
          edition,
          store,
          slots,
          wallet,
          cashu,
          crypto: walletCrypto,
          fetch: scope.fetch as typeof fetch,
          seed
        })
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
  }
}

export type Device = ReturnType<typeof device>

/** A device that used the collection before account seeds, holding cards. */
export const deviceWithCards = async (
  mint: TestNutftMint,
  cards: number[],
  options: DeviceOptions = {}
) => {
  const phone = device(mint, options)
  const old = phone.open()
  await old.session.open()
  const address = await old.session.destination()
  for (const card of cards)
    await old.wallet.importToken(mint.url, mint.issue(address, card))
  return {phone, address}
}

/** The account wallet as a device that already restored it would hold it. */
export const restoredAccount = async (phone: Device, seed: string) => {
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

/** One token carrying several cards, as a multi-card handover would. */
export const cardsToken = (
  mint: TestNutftMint,
  pubkey: string,
  cards: number[]
): string =>
  cashu.getEncodedToken({
    mint: mint.url,
    unit: mint.unit,
    proofs: cards.flatMap(
      card => cashu.getDecodedToken(mint.issue(pubkey, card), [mint.id]).proofs
    )
  })

type Answer = (
  request: NutftRequest,
  ask: TestNutftMint['request']
) => ReturnType<TestNutftMint['request']> | undefined

/**
 * Put a filter in front of the mint. The filter answers a request itself or
 * returns undefined to let the mint answer. Resolves to a function that takes
 * the filter away again.
 */
export const intercept = (mint: TestNutftMint, answer: Answer) => {
  const ask = mint.request.bind(mint)
  mint.request = async request => (await answer(request, ask)) ?? ask(request)
  return () => {
    mint.request = ask
  }
}

/** Answer the n-th call of an operation (1-based) as a rate limiter would. */
export const rateLimit = (
  mint: TestNutftMint,
  operation: NutftOperation,
  nth: number | ((n: number) => boolean),
  body = '{"error":"rate limited"}'
) => {
  let n = 0
  return intercept(mint, async request => {
    if (request.operation !== operation) return undefined
    n += 1
    if (!(typeof nth === 'number' ? n === nth : nth(n))) return undefined
    mint.calls.push(request)
    return {status: 429, body, retryAfterMs: 1000}
  })
}

/** Make every call of an operation fail before the mint does anything. */
export const unreachable = (mint: TestNutftMint, operation: NutftOperation) =>
  intercept(mint, async request => {
    if (request.operation !== operation) return undefined
    throw new Error('Mint request unavailable, denied, or interrupted.')
  })

/** Refuse, once, the first write of a key whose value matches. */
export const refuseWrite = (
  storage: Storage,
  key: string,
  matches: (value: string) => boolean | Promise<boolean>
) => {
  const write = storage.setItem
  let armed = true
  storage.setItem = async (target, value) => {
    if (armed && target === key && (await matches(value))) {
      armed = false
      throw new Error('storage refused')
    }
    return write(target, value)
  }
}

/** Refuse the journal write that records the first finished trade. */
export const refuseJournalAfterTrade = (storage: Storage, seed = ACCOUNT_A) =>
  refuseWrite(storage, MIGRATION_KEY, async value => {
    const record = JSON.parse(value)
    if (!record.box) return false
    const journal = JSON.parse(
      await sealedWith(seed).open(record.box, MIGRATION_KEY)
    )
    return journal.steps.some(
      (step: {state: string}) => step.state === 'traded'
    )
  })

/** Every console method, so a test can say that nothing reached any of them. */
export const watchConsole = () => {
  const said: unknown[][] = []
  const spies = (
    ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
  ).map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      said.push(args)
    })
  )
  return {said, restore: () => spies.forEach(spy => spy.mockRestore())}
}

export const secretOf = (item: unknown): string =>
  (item as {proof: {secret: string}}).proof.secret

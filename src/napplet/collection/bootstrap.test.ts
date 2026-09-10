import {describe, expect, it, vi} from 'vitest'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import * as cashu from '@cashu/cashu-ts'
import * as bip39 from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey} from '@scure/bip32'
import {
  CollectionNotReady,
  prepareCollectionGlobals,
  storageKeyFor
} from './bootstrap'
import type {BootstrapDeps, CollectionEdition} from './bootstrap'

const VENDOR = fileURLToPath(
  new URL('./vendor/nutft-wallet.js', import.meta.url)
)

const UPSTREAM_SHA256 =
  '5e73a4426b04ddecf03f9c671ec771fd1a4eb5350136624035756c1f16272572'

const edition: CollectionEdition = {
  id: '600b-e1',
  mint: 'https://tcg.example/g',
  units: ['e1'],
  mirrors: ['https://blossom.primal.net']
}

/** A store that behaves like the shell's: asynchronous, and able to refuse. */
const memoryStore = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: vi.fn(async (key: string) => map.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      map.set(key, value)
    })
  }
}

const deps = (over: Partial<BootstrapDeps> = {}): BootstrapDeps => ({
  storage: memoryStore(),
  nutft: {request: vi.fn(async () => ({status: 200, body: '{}'}))},
  resource: {bytes: vi.fn(async () => new Blob(['x']))},
  cashu,
  walletCrypto: {...bip39, wordlist, HDKey},
  ...over
})

describe('the vendored copy', () => {
  it('is byte-identical to the commit its provenance names', () => {
    const hash = createHash('sha256').update(readFileSync(VENDOR)).digest('hex')
    /* Editing the vendored file locally is what this catches. Re-syncing from
       upstream means updating vendor/README.md and this hash together. */
    expect(hash).toBe(UPSTREAM_SHA256)
  })
})

describe('prepareCollectionGlobals', () => {
  it('installs what the library reads, and takes away the signer', () => {
    const scope: Record<string, unknown> = {}
    const d = deps()
    prepareCollectionGlobals(scope, edition, d)
    expect(scope.NUTFT_STORE).toBe('bearlett:nutft:600b-e1')
    expect(scope.NUTFT_UNITS).toEqual(['e1'])
    expect(scope.__cashu).toBe(d.cashu)
    expect(scope.__walletCrypto).toBe(d.walletCrypto)
    expect(typeof scope.fetch).toBe('function')
    expect(scope.nostr).toBeUndefined()
    expect(Reflect.getOwnPropertyDescriptor(scope, 'nostr')?.configurable).toBe(
      false
    )
  })

  it('passes storage straight through to the shell', async () => {
    const scope: Record<string, unknown> = {}
    const store = memoryStore()
    prepareCollectionGlobals(scope, edition, deps({storage: store}))
    const port = scope.NUTFT_STORAGE as {
      getItem(key: string): Promise<string | null>
      setItem(key: string, value: string): Promise<void>
    }
    expect(await port.getItem('absent')).toBeNull()
    await port.setItem('k', 'v')
    expect(store.setItem).toHaveBeenCalledWith('k', 'v')
    expect(await port.getItem('k')).toBe('v')
  })

  it('leaves the unit pin off when the collection names none', () => {
    const scope: Record<string, unknown> = {}
    prepareCollectionGlobals(scope, {...edition, units: []}, deps())
    expect('NUTFT_UNITS' in scope).toBe(false)
  })

  it('refuses a second preparation rather than nesting two routers', () => {
    const scope: Record<string, unknown> = {}
    prepareCollectionGlobals(scope, edition, deps())
    expect(() => prepareCollectionGlobals(scope, edition, deps())).toThrow(
      CollectionNotReady
    )
  })

  it('refuses an id that would make an unusable storage key', () => {
    for (const id of ['', 'Has Caps', 'has/slash', '-leading', 'x'.repeat(64)])
      expect(() =>
        prepareCollectionGlobals({}, {...edition, id}, deps())
      ).toThrow(CollectionNotReady)
  })

  it('gives the library a fetch that refuses a foreign address', async () => {
    const scope: Record<string, unknown> = {}
    const d = deps()
    prepareCollectionGlobals(scope, edition, d)
    const fetcher = scope.fetch as typeof fetch
    await expect(fetcher('https://evil.example/x')).rejects.toThrow()
    expect(d.nutft.request).not.toHaveBeenCalled()
    /* And that it does reach the mint for a path the contract knows. */
    await fetcher('https://tcg.example/g/v1/info')
    expect(d.nutft.request).toHaveBeenCalledWith({
      mint: 'https://tcg.example/g',
      operation: 'info'
    })
  })

  it('names the storage key from the collection id alone', () => {
    expect(storageKeyFor({id: 'pokemon-base'})).toBe(
      'bearlett:nutft:pokemon-base'
    )
  })
})

/**
 * The integration that matters. The vendored library is loaded for real, in a
 * fresh realm carrying exactly the globals the bootstrap installs, and then
 * asked to do a wallet operation that touches no network.
 *
 * `destination()` was chosen because it exercises the whole injection: it
 * generates a mnemonic and derives an HD key through `__walletCrypto`, derives
 * the public key through `__cashu`, and reads and writes through the storage
 * port. If the versions this repository bundles were incompatible with what the
 * library expects, this is where it would show.
 */
describe('the vendored library, actually running', () => {
  const realm = (
    store: ReturnType<typeof memoryStore>,
    extra: Record<string, unknown> = {}
  ) => {
    const scope: Record<string, unknown> = {
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      btoa: (value: string) => globalThis.btoa(value),
      console,
      ...extra
    }
    prepareCollectionGlobals(scope, edition, deps({storage: store}))
    const context = vm.createContext(scope)
    /* The library closes over `globalThis`, so the context must be its own. */
    context.globalThis = context
    vm.runInContext(readFileSync(VENDOR, 'utf8'), context, {filename: VENDOR})
    return context
  }

  const walletIn = (context: Record<string, unknown>) =>
    context.NutFTWallet as Record<
      string,
      (...args: never[]) => Promise<unknown>
    >

  it('starts and derives a destination with no network at all', async () => {
    const store = memoryStore()
    const wallet = walletIn(realm(store))
    expect(typeof wallet.destination).toBe('function')

    const pubkey = (await wallet.destination()) as string
    expect(pubkey).toMatch(/^[0-9a-f]{66}$/)

    /* The identity was persisted through the injected port, under our key. */
    expect(store.setItem).toHaveBeenCalled()
    const saved = store.map.get('bearlett:nutft:600b-e1')
    expect(saved).toBeTruthy()
    const state = JSON.parse(String(saved))
    expect(state.pubkey).toBe(pubkey)
    expect(state.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(String(state.seedPhrase).split(' ')).toHaveLength(12)
    expect(state.tokens).toEqual([])

    /* And it is stable: a second call returns the same key, not a new wallet. */
    expect(await wallet.destination()).toBe(pubkey)
  })

  it('reads back an existing wallet instead of creating one', async () => {
    const store = memoryStore()
    const pubkey = await walletIn(realm(store)).destination()

    /* A fresh realm over the same store: this is a reload of the napplet. */
    expect(await walletIn(realm(store)).destination()).toBe(pubkey)
    expect(store.map.size).toBe(1)
  })

  it('never reaches a signer, even though the library would look for one', () => {
    const context = realm(memoryStore(), {nostr: {signEvent: vi.fn()}})
    expect(context.nostr).toBeUndefined()
    expect(typeof walletIn(context).destination).toBe('function')
  })

  /**
   * The library encodes a card by taking cashu-ts's binary token and dropping
   * five bytes, because that is the length of the `crawB` prefix. Nothing
   * enforces that assumption across a version change, and a wrong offset would
   * not throw: it would produce a token that decodes to nothing.
   */
  it('still encodes a token the way it assumes cashu-ts lays one out', () => {
    const wallet = walletIn(realm(memoryStore())) as unknown as {
      encodeToken(module: unknown, token: unknown): string
    }
    const token = {
      mint: edition.mint,
      unit: 'e1',
      proofs: [
        {
          id: '00ad268c4d1f5826',
          amount: 1,
          secret: '9a'.padEnd(64, '0'),
          C: '02' + 'ab'.repeat(32)
        }
      ]
    }
    const encoded = wallet.encodeToken(cashu, token)
    expect(encoded.startsWith('cashuB')).toBe(true)

    /* The five dropped bytes really are the prefix, not part of the payload. */
    const binary = cashu.getEncodedTokenBinary(token as never)
    expect(new TextDecoder().decode(binary.slice(0, 5))).toBe('crawB')

    /* And cashu-ts reads its own encoding back to the same card. The keyset
       ids are a required argument in 4.10.1, and the library passes them at
       every one of its five decode sites, so the calling convention still
       matches. Omitting them throws rather than guessing, which is the
       behaviour worth relying on. */
    expect(() =>
      (cashu.getDecodedToken as (t: string) => unknown)(encoded)
    ).toThrow()
    const decoded = cashu.getDecodedToken(encoded, [token.proofs[0].id])
    expect(decoded.mint).toBe(edition.mint)
    expect(decoded.unit).toBe('e1')
    expect(decoded.proofs).toHaveLength(1)
    expect(decoded.proofs[0].C).toBe(token.proofs[0].C)

    /* A decoded amount is an Amount over a BigInt, not a number, and that is
       the convention the library is written against: it builds amounts with
       `Amount.from(1)` and checks cards with `proof.amount.toString() !== "1"`
       at both of its verification sites. A plain `=== 1` would silently reject
       every card, so the shape is asserted here rather than assumed. */
    expect(typeof decoded.proofs[0].amount).not.toBe('number')
    expect(decoded.proofs[0].amount.toString()).toBe('1')
    expect(cashu.Amount.from(1).toString()).toBe('1')
  })
})

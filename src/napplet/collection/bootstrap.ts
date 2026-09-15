import {sealSigner} from './no-signer'
import {createCollectionFetch} from './transport'
import type {ResourceBytes} from './transport'
import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'
import type {NutftHost, NutftOperation} from '../../host/nutft-contract'
import {openSession} from './session'
import type {CollectionSession, TokenTools} from './session'
import type {SeedCrypto} from './seed'
import {createWalletSlots, createWalletStore, storageKeyFor} from './wallets'

export {storageKeyFor}

/**
 * Everything the vendored card wallet needs before it may run.
 *
 * The library is an IIFE over `globalThis` that reads twelve names off it. Five
 * have to be supplied, one has to be taken away, and the rest the sandbox
 * already provides. Three of the five are read while the file evaluates, not
 * when it is first used, so they must be in place before the import, which is
 * why the import here is dynamic and this module is not merely a wrapper.
 *
 * The inventory behind these choices is docs/NUTFT-LIBRARY-WIRING-2026-09-10.md.
 */

/** One collection. One napplet, one mint, one storage key. */
export type CollectionEdition = {
  /** Short, stable slug. It names the storage key, so it never changes. */
  id: string
  /** Canonical mint URL, path included: the G edition lives under `/g`. */
  mint: string
  /** Unit names this collection accepts. Empty means the library's default. */
  units: readonly string[]
  /** Blossom origins allowed to serve card faces and catalogue blobs. */
  mirrors: readonly string[]
  /**
   * Open the account's own wallet from the lease's seed, restore it and offer
   * to move the device's cards into it. A build flag, off unless the build
   * turned it on: without it a valid seed is checked and then left unused.
   */
  accountWallets?: boolean
}

/** An asynchronous key/value store. The shape the library's port expects. */
export type AsyncStore = {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export type BootstrapDeps = {
  storage: AsyncStore
  nutft: NutftHost
  resource: ResourceBytes
  /** The cashu-ts module namespace. */
  cashu: object
  /** `{...bip39, wordlist, HDKey}`, the shape the library merges itself. */
  walletCrypto: object
  /** Told the name of each mint operation as it starts. Never its body. */
  observe?: (operation: NutftOperation, detail?: {retryInMs?: number}) => void
  /** How the transport waits before asking the mint again. Tests pass a fake. */
  sleep?: (ms: number) => Promise<void>
}

export class CollectionNotReady extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectionNotReady'
  }
}

/**
 * Take the Web Locks API away from the library.
 *
 * A napplet runs in a `sandbox="allow-scripts"` frame with an opaque origin,
 * and Chromium answers `navigator.locks.request` there with a SecurityError,
 * so the first wallet operation fails before storage is even read. The library
 * already has an in-window queue for a browser without locks, and the shell's
 * lease (`nutft.acquire`) is what keeps one collection to one window, so the
 * lock adds nothing here but the failure.
 *
 * Only `locks` is shadowed, as an own property of the navigator object;
 * everything else on `navigator` stays exactly as the platform provides it.
 */
function hideWebLocks(scope: Record<string, unknown>): void {
  const navigator = scope.navigator
  if (!navigator || typeof navigator !== 'object') return
  try {
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true
    })
  } catch {
    /* Checked below: what matters is what the library will read. */
  }
  if ((navigator as {locks?: unknown}).locks !== undefined)
    throw new CollectionNotReady(
      'This collection cannot run beside a lock service it is not allowed to use.'
    )
}

/**
 * Install the globals, in the order the library reads them.
 *
 * Separated from the import so it can be tested against a scope that is not the
 * real global object. It is deliberately not idempotent for `fetch`: calling it
 * twice on one scope would wrap an already-wrapped fetch, so a second call is
 * refused rather than quietly nesting two routers.
 */
export function prepareCollectionGlobals(
  scope: Record<string, unknown>,
  edition: CollectionEdition,
  deps: BootstrapDeps
): void {
  if (scope.__bearlettCollection)
    throw new CollectionNotReady(
      'This collection has already been prepared in this window.'
    )
  if (!edition.id || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(edition.id))
    throw new CollectionNotReady(
      'A collection needs a short lowercase id; it names the storage key.'
    )

  /* First, before any of the rest can matter. */
  sealSigner(scope)
  hideWebLocks(scope)

  /* Read while the library evaluates. */
  scope.NUTFT_STORE = storageKeyFor(edition)
  if (edition.units.length) scope.NUTFT_UNITS = [...edition.units]
  scope.NUTFT_STORAGE = {
    getItem: (key: string) => deps.storage.getItem(key),
    setItem: (key: string, value: string) => deps.storage.setItem(key, value)
  }

  /* Read lazily, but there is no reason to defer them. Without both, every path
     that touches a proof fails: the library's own fallback imports them from a
     CDN, and a napplet runs under `connect-src 'none'`. */
  scope.__cashu = deps.cashu
  scope.__walletCrypto = deps.walletCrypto

  /* The library uses plain `fetch`. A napplet has no network, so this is the
     router: mint paths become capability operations, allow-listed mirrors
     become byte fetches, everything else is refused. */
  scope.fetch = createCollectionFetch({
    mint: edition.mint,
    nutft: deps.nutft,
    resource: deps.resource,
    mirrors: edition.mirrors,
    observe: deps.observe,
    sleep: deps.sleep
  })

  scope.__bearlettCollection = edition.id
}

/**
 * What the vendored library publishes, with the signatures it really has. Only
 * what this napplet calls. Every card operation names its mint first: the
 * library compares a token's mint string with it exactly.
 */
export type NutFTWalletApi = {
  read(): Promise<unknown>
  snapshot(mintUrl: string): Promise<unknown>
  snapshotMany(mintUrls: readonly string[]): Promise<unknown>
  destination(): Promise<unknown>
  importToken(mintUrl: string, token: string): Promise<unknown>
  tradeProof(
    mintUrl: string,
    secret: string,
    recipientPubkey: string
  ): Promise<unknown>
  recoverPending(): Promise<unknown>
  restoreSeed(mintUrl: string, phrase: string): Promise<unknown>
  encodeToken(...args: readonly unknown[]): unknown
  exportBackup(): Promise<unknown>
  restoreBackup(text: string): Promise<unknown>
  outgoing(): Promise<unknown>
  forgetOutgoing(token: string): Promise<unknown>
  hex(bytes: Uint8Array): string
  bytes(value: string): Uint8Array
}

/**
 * Prepare the global object, load the wallet and open the collection.
 *
 * A seed from the lease is checked before anything is touched: a seed that is
 * present but not 64 lowercase hex stops here, with no global prepared and no
 * wallet loaded, rather than falling back to a random wallet.
 */
export async function startCollectionWallet(
  edition: CollectionEdition,
  deps: BootstrapDeps & {seed?: string}
): Promise<CollectionSession> {
  if (deps.seed !== undefined && !isHostSeed(deps.seed)) throw new UnsafeLease()
  const scope = globalThis as unknown as Record<string, unknown>
  const store = createWalletStore(deps.storage)
  const slots = createWalletSlots(store, storageKeyFor(edition))
  prepareCollectionGlobals(scope, edition, {...deps, storage: slots.port})
  await import('./vendor/nutft-wallet.js')
  const wallet = scope.NutFTWallet as NutFTWalletApi | undefined
  if (!wallet || typeof wallet.read !== 'function')
    throw new CollectionNotReady('The card wallet did not load.')
  return openSession({
    edition,
    store,
    slots,
    wallet,
    cashu: deps.cashu as TokenTools,
    crypto: deps.walletCrypto as SeedCrypto,
    seed: deps.seed
  })
}

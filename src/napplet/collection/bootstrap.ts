import {sealSigner} from './no-signer'
import {createCollectionFetch} from './transport'
import type {ResourceBytes} from './transport'
import type {NutftHost} from '../../host/nutft-contract'

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
}

/**
 * The wallet's storage key.
 *
 * A shell scopes storage per napplet, so two collections would not collide even
 * under one key. The key is namespaced anyway, because that assumption belongs
 * to the shell rather than to this wallet, and a shell that scoped per origin
 * instead would silently merge two collections into one wallet. Choosing now
 * costs nothing; no cards are stored under any other key yet.
 */
export const storageKeyFor = (edition: Pick<CollectionEdition, 'id'>): string =>
  `bearlett:nutft:${edition.id}`

export class CollectionNotReady extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CollectionNotReady'
  }
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
    mirrors: edition.mirrors
  })

  scope.__bearlettCollection = edition.id
}

/** What the vendored library publishes. Only what this napplet actually calls. */
export type NutFTWalletApi = {
  read(): Promise<unknown>
  snapshot(mintUrl: string): Promise<unknown>
  snapshotMany(mintUrls: readonly string[]): Promise<unknown>
  destination(): Promise<unknown>
  importToken(token: string): Promise<unknown>
  tradeProof(...args: readonly unknown[]): Promise<unknown>
  encodeToken(...args: readonly unknown[]): unknown
  exportBackup(): Promise<unknown>
  restoreBackup(text: string): Promise<unknown>
  outgoing(): Promise<unknown>
  forgetOutgoing(...args: readonly unknown[]): Promise<unknown>
  hex(bytes: Uint8Array): string
  bytes(value: string): Uint8Array
}

/**
 * Prepare the global object and load the wallet. Resolves to the library's own
 * export, so nothing else in the napplet has to reach for a global.
 */
export async function startCollectionWallet(
  edition: CollectionEdition,
  deps: BootstrapDeps
): Promise<NutFTWalletApi> {
  const scope = globalThis as unknown as Record<string, unknown>
  prepareCollectionGlobals(scope, edition, deps)
  await import('./vendor/nutft-wallet.js')
  const wallet = scope.NutFTWallet as NutFTWalletApi | undefined
  if (!wallet || typeof wallet.read !== 'function')
    throw new CollectionNotReady('The card wallet did not load.')
  return wallet
}

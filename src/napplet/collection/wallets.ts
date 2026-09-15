import type {AsyncStore, CollectionEdition} from './bootstrap'

/**
 * Where a collection keeps its wallets.
 *
 * A collection can hold more than one wallet over its life. The first one a
 * device ever had was generated from a random mnemonic, under the key the
 * collection has always used. Once the shell hands over an account seed, that
 * account's wallet lives beside it under a key named by the seed's
 * fingerprint, so a second account on the same device gets a second wallet and
 * neither one can read or overwrite the other.
 *
 * The card library has one storage key, read once when it loads. The slots
 * below give it that one key and decide, per operation, which wallet the key
 * means. A wallet is never switched while a library call is running; the
 * session serialises every call for exactly that reason.
 */

/** Where a wallet's mnemonic came from. */
export type SeedSource = 'random' | 'host'

/**
 * The wallet's storage key.
 *
 * A shell scopes storage per napplet, so two collections would not collide even
 * under one key. The key is namespaced anyway, because that assumption belongs
 * to the shell rather than to this wallet, and a shell that scoped per origin
 * instead would silently merge two collections into one wallet. It is also the
 * key of the device's random-mnemonic wallet, which is where every card held
 * before account seeds existed still lives.
 */
export const storageKeyFor = (edition: Pick<CollectionEdition, 'id'>): string =>
  `bearlett:nutft:${edition.id}`

/** An account's wallet, named by its seed fingerprint and never by the seed. */
export const hostWalletKey = (
  edition: Pick<CollectionEdition, 'id'>,
  fingerprint: string
): string => `${storageKeyFor(edition)}:${fingerprint}`

/** The journal of a move from the random wallet to an account. */
export const migrationKey = (edition: Pick<CollectionEdition, 'id'>): string =>
  `${storageKeyFor(edition)}:migration`

/** A wallet state as the card library stores it, plus two fields of ours. */
export type StoredWallet = {
  privateKey: string
  pubkey: string
  seedPhrase?: string | null
  counters?: Record<string, number> | null
  tokens: string[]
  pending?: {type?: string; input_secret?: string} | null
  outgoing?: Array<{token: string; asset_id?: string | null; at?: string}>
  /** Absent on a wallet older than this field, and every such wallet was random. */
  seedSource?: SeedSource
  /** Present until an account wallet has been restored from the mint. */
  restore?: 'pending'
  /**
   * Proof secrets received here that still wait to be re-issued to this
   * wallet's own outputs, the only outputs a restore from its seed can find.
   * Written before the card is imported, and cleared once its proof is spent.
   */
  reissue?: string[]
  /**
   * On an account wallet: the public key of the device wallet its cards were
   * moved from. After a move only that device wallet's sent transfers are
   * shown beside the account's, and no other device wallet is ever offered.
   */
  movedFrom?: string
}

export class WalletUnreadable extends Error {
  constructor() {
    super(
      'A card wallet in this collection cannot be read. Nothing was changed. ' +
        'Keep this device as it is and ask for help before trying again.'
    )
    this.name = 'WalletUnreadable'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The card library's own shape check, and ours on top. */
export const isStoredWallet = (value: unknown): value is StoredWallet =>
  isRecord(value) &&
  typeof value.privateKey === 'string' &&
  typeof value.pubkey === 'string' &&
  (value.seedPhrase == null || typeof value.seedPhrase === 'string') &&
  (value.counters == null || isRecord(value.counters)) &&
  Array.isArray(value.tokens) &&
  value.tokens.every(token => typeof token === 'string') &&
  (value.pending == null || typeof value.pending === 'object') &&
  (value.outgoing == null ||
    (Array.isArray(value.outgoing) &&
      value.outgoing.every(entry => isRecord(entry)))) &&
  (value.seedSource === undefined ||
    value.seedSource === 'random' ||
    value.seedSource === 'host') &&
  (value.restore === undefined || value.restore === 'pending') &&
  (value.reissue === undefined ||
    (Array.isArray(value.reissue) &&
      value.reissue.every(secret => typeof secret === 'string'))) &&
  (value.movedFrom === undefined ||
    (typeof value.movedFrom === 'string' &&
      /^0[23][0-9a-f]{64}$/.test(value.movedFrom)))

/** Read a wallet without the library. Absent is `null`; damaged throws. */
export async function readWallet(
  store: AsyncStore,
  key: string
): Promise<StoredWallet | null> {
  const text = await store.getItem(key)
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new WalletUnreadable()
  }
  if (!isStoredWallet(value)) throw new WalletUnreadable()
  return value
}

export const writeWallet = (
  store: AsyncStore,
  key: string,
  wallet: StoredWallet
): Promise<void> => store.setItem(key, JSON.stringify(wallet))

/** Turns a stored value into what is read, and back. */
export type Codec = {
  open(stored: string, key: string): Promise<string>
  seal(value: string, key: string): Promise<string>
}

export type WalletStore = AsyncStore & {
  /** Seal this key's value from now on, and open it on every read. */
  protect(key: string, codec: Codec): void
}

/** The shell's storage, with a codec on the keys that asked for one. */
export function createWalletStore(storage: AsyncStore): WalletStore {
  const codecs = new Map<string, Codec>()
  return {
    protect: (key, codec) => {
      codecs.set(key, codec)
    },
    getItem: async key => {
      const stored = await storage.getItem(key)
      const codec = codecs.get(key)
      return stored === null || !codec ? stored : codec.open(stored, key)
    },
    setItem: async (key, value) => {
      const codec = codecs.get(key)
      await storage.setItem(key, codec ? await codec.seal(value, key) : value)
    }
  }
}

export type WalletSlots = {
  /** What the card library is given as its storage. */
  port: AsyncStore
  /** Let the library's key mean this wallet until the next select. */
  select(key: string): void
  selected(): string
}

/**
 * One storage key for the library, any number of wallets behind it.
 *
 * Every key but the library's own passes straight through, so the catalogue
 * cache stays shared: it is public, signed data and the same for every wallet.
 */
export function createWalletSlots(
  store: AsyncStore,
  libraryKey: string
): WalletSlots {
  let current = libraryKey
  const route = (key: string) => (key === libraryKey ? current : key)
  return {
    port: {
      getItem: key => store.getItem(route(key)),
      setItem: (key, value) => store.setItem(route(key), value)
    },
    select: key => {
      current = key
    },
    selected: () => current
  }
}

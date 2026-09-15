import type {CollectionEdition} from './bootstrap'

/**
 * The collections this repository can build a napplet for.
 *
 * One napplet per collection is the ground rule, so an edition is not something
 * the running napplet chooses: it is baked in at build time and the bundle is
 * named after it. What lives here is only what is stable about a collection.
 * The mint address is not stable, so it is not here; see `resolveEdition`.
 */

export type Edition = {
  /** Build mode and storage namespace. Lowercase, stable forever. */
  id: string
  /** Shown in the napplet's own chrome. */
  title: string
  /** The mint's unit name, which is also the collection id it signs. */
  collectionId: string
  /** Blossom origins the catalogue lists for card faces. */
  mirrors: readonly string[]
}

export const EDITIONS: Readonly<Record<string, Edition>> = {
  '600b-e1': {
    id: '600b-e1',
    title: '600B Edition One',
    collectionId: '600B-E1',
    mirrors: [
      'https://blossom.primal.net',
      'https://blossom.bimcvp.com',
      'https://nostr.download'
    ]
  },
  '600b-g': {
    id: '600b-g',
    title: '600B G',
    collectionId: '600B-G',
    mirrors: [
      'https://blossom.primal.net',
      'https://blossom.bimcvp.com',
      'https://nostr.download'
    ]
  }
}

export class UnknownEdition extends Error {
  constructor(id: string) {
    super(
      `No collection called "${id}". Known collections: ${Object.keys(EDITIONS)
        .sort()
        .join(', ')}.`
    )
    this.name = 'UnknownEdition'
  }
}

export class MintNotConfigured extends Error {
  constructor(id: string) {
    super(
      `Building the ${id} collection needs its mint address. ` +
        'Pass BEARLETT_MINT to the build.'
    )
    this.name = 'MintNotConfigured'
  }
}

export class InvalidMint extends Error {
  constructor(reason: string) {
    super(`BEARLETT_MINT ${reason}`)
    this.name = 'InvalidMint'
  }
}

/**
 * Check the mint address exactly as it will be compiled in.
 *
 * Nothing is normalised. The card wallet compares a token's mint string with
 * this one character for character, so a trailing slash or a capital letter
 * here would refuse every card the mint issues, and the napplet would say the
 * cards belong to another mint. The build stops instead and says what to write.
 */
export function checkMintAddress(mint: string): string {
  let url: URL
  try {
    url = new URL(mint)
  } catch {
    throw new InvalidMint('is not a URL.')
  }
  if (url.protocol !== 'https:') throw new InvalidMint('must use https.')
  if (url.username || url.password)
    throw new InvalidMint('must not carry credentials.')
  if (url.search || url.hash || /[?#]/.test(mint))
    throw new InvalidMint('must not carry a query or a fragment.')
  if (mint.endsWith('/'))
    throw new InvalidMint(
      `must not end with a slash: use ${mint.replace(/\/+$/, '')}.`
    )
  const canonical = url.href.replace(/\/$/, '')
  if (canonical !== mint)
    throw new InvalidMint(
      `must be written as the mint writes it: ${canonical}.`
    )
  return mint
}

export class InvalidAccountWallets extends Error {
  constructor() {
    super(
      'BEARLETT_ACCOUNT_WALLETS must be 1 to build account wallets in, or 0 ' +
        'or unset to leave them out.'
    )
    this.name = 'InvalidAccountWallets'
  }
}

/**
 * Whether a build opens account wallets and offers to move a device's cards.
 *
 * Off unless the build says `1`, and a value that is neither `0` nor `1` stops
 * the build: `true` or `yes` meaning off would be the silent kind of wrong.
 */
export function accountWalletsFrom(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === '0') return false
  if (value === '1') return true
  throw new InvalidAccountWallets()
}

/**
 * Bind an edition to the mint that issues it.
 *
 * The mint address is a build input rather than a constant, and there is no
 * default. A napplet that pointed at the wrong mint would show an empty
 * collection and blame the wallet, and a guessed address checked into a
 * repository is exactly how that happens. Failing the build is louder.
 *
 * Account wallets are a build input too, and off by default: the alpha build
 * opens the device's own wallet whatever seed the shell sends.
 */
export function resolveEdition(
  id: string,
  mint: string | undefined,
  accountWallets?: string
): CollectionEdition {
  const edition = editionById(id)
  if (!edition) throw new UnknownEdition(id)
  if (!mint) throw new MintNotConfigured(id)
  checkMintAddress(mint)
  return {
    id: edition.id,
    mint,
    units: [edition.collectionId],
    mirrors: edition.mirrors,
    accountWallets: accountWalletsFrom(accountWallets)
  }
}

/**
 * Look an edition up by id.
 *
 * `Object.hasOwn` rather than `in` or a bare index, because `in` walks the
 * prototype chain: `--mode constructor` would otherwise pass for a collection
 * and hand the build `Object` itself, producing a napplet with no id, no unit
 * and no mint. It is an odd input, but the failure is silent, which is worse
 * than odd.
 */
export const editionById = (id: string): Edition | null =>
  Object.hasOwn(EDITIONS, id) ? EDITIONS[id] : null

/** Whether a build mode names a collection rather than one of the other apps. */
export const isEditionMode = (mode: string): boolean =>
  editionById(mode) !== null

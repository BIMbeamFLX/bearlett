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

/**
 * Bind an edition to the mint that issues it.
 *
 * The mint address is a build input rather than a constant, and there is no
 * default. A napplet that pointed at the wrong mint would show an empty
 * collection and blame the wallet, and a guessed address checked into a
 * repository is exactly how that happens. Failing the build is louder.
 */
export function resolveEdition(
  id: string,
  mint: string | undefined
): CollectionEdition {
  const edition = editionById(id)
  if (!edition) throw new UnknownEdition(id)
  if (!mint) throw new MintNotConfigured(id)
  return {
    id: edition.id,
    mint,
    units: [edition.collectionId],
    mirrors: edition.mirrors
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

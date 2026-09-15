/**
 * The inventory a collection tells other napplets about.
 *
 * A game that wants to know which cards a holder owns must not be handed the
 * proofs: a proof is the card, and whoever holds its secret can spend it. So
 * what leaves this napplet is a count per asset id and nothing else. The shape
 * is `nutft/inventory` v1, fixed with the host and the game; `parseInventory`
 * is the strict reading of it, and `buildInventory` runs its own output through
 * that reading so the two can never drift apart.
 */
import type {CollectionEdition} from './bootstrap'
import type {Snapshot} from './cards'

export const INVENTORY_CONVENTION = 'napplet:collection/inventory'
export const INVENTORY_KIND = 'nutft/inventory'
export const INVENTORY_REQUEST_KIND = 'nutft/inventory-request'
/** Storage key the host reads the last inventory from. */
export const INVENTORY_STORAGE_KEY = 'inventory'
/**
 * Storage key naming the wallet the stored inventory was counted from. The
 * host reads only `inventory`; this one is the collection's own record, so an
 * inventory never stands without the wallet it belongs to.
 */
export const INVENTORY_WALLET_KEY = 'inventory:wallet'
export const MAX_INVENTORY_CARDS = 4096
/* The strictest reader of this payload, the host's, takes exactly these. A
   looser writer would only find out when the host dropped the payload. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_URI = 2048

export type InventoryCard = {
  asset_id: string
  /** Copies held. Never zero: a card not held is not listed. */
  count: number
}

export type Inventory = {
  v: 1
  kind: typeof INVENTORY_KIND
  edition: string
  collection_id: string
  catalog_uri: string
  mint: string
  /** Unix seconds when the counts were taken. */
  at: number
  /** Sorted by `asset_id`, code-unit order, no repeats. */
  cards: InventoryCard[]
}

/** A request for the current inventory, as another napplet emits it. */
export type InventoryRequest = {
  v: 1
  kind: typeof INVENTORY_REQUEST_KIND
  edition: string
}

const INVENTORY_FIELDS = [
  'v',
  'kind',
  'edition',
  'collection_id',
  'catalog_uri',
  'mint',
  'at',
  'cards'
] as const
const CARD_FIELDS = ['asset_id', 'count'] as const

/* Code-unit order, on purpose: `localeCompare` depends on the locale of whoever
   sorts, and two napplets in two locales would disagree on what "sorted" is. */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Count the held cards of one edition.
 *
 * Counts by the proof's own `nutft` tag rather than by the catalogue entry it
 * resolved to, because the tag is what the mint signed. `now` is unix seconds.
 */
export function buildInventory(
  edition: CollectionEdition,
  snapshot: Snapshot,
  now: number
): Inventory {
  const counts = new Map<string, number>()
  for (const item of snapshot.owned) {
    const id = item?.tag?.[2] ?? item?.asset?.asset_id
    if (typeof id !== 'string' || !id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return parseInventory({
    v: 1,
    kind: INVENTORY_KIND,
    edition: edition.id,
    collection_id: edition.units[0] ?? snapshot.catalog?.collection_id ?? '',
    catalog_uri: snapshot.catalog?.catalog_uri ?? '',
    mint: edition.mint,
    at: Math.floor(now),
    cards: [...counts.keys()]
      .sort(byId)
      .map(asset_id => ({asset_id, count: counts.get(asset_id)!}))
  })
}

const fail = (what: string): never => {
  throw new Error(`Not a nutft/inventory: ${what}.`)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactFields = (
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string
): void => {
  for (const key of allowed)
    if (!Object.hasOwn(record, key)) fail(`${where} lacks "${key}"`)
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) fail(`${where} has an unexpected "${key}"`)
}

const idField = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !ID.test(value))
    fail(
      `"${name}" must be 1 to 64 letters, digits, dots, underscores or ` +
        'hyphens, starting with a letter or digit'
    )
  return value as string
}

/** An https URL with no credentials, or `""` where `empty` allows it. */
const httpsField = (value: unknown, name: string, empty: boolean): string => {
  const refuse = () =>
    fail(
      `"${name}" must be ${empty ? 'empty or ' : ''}an https URL of at most ${MAX_URI} characters`
    )
  if (typeof value !== 'string' || value.length > MAX_URI) refuse()
  if (empty && value === '') return value as string
  let url: URL | null = null
  try {
    url = new URL(value as string)
  } catch {
    refuse()
  }
  if (url!.protocol !== 'https:' || url!.username || url!.password) refuse()
  return value as string
}

/**
 * Read an inventory strictly.
 *
 * Every field is required, nothing else is allowed, and the cards must already
 * be sorted. Anything that fails is refused with a reason, because a lenient
 * reader would be the place a proof or a pubkey slips through unnoticed.
 */
export function parseInventory(value: unknown): Inventory {
  const record: Record<string, unknown> = isRecord(value)
    ? value
    : fail('expected an object')
  exactFields(record, INVENTORY_FIELDS, 'the inventory')
  if (record.v !== 1) fail('"v" must be 1')
  if (record.kind !== INVENTORY_KIND) fail(`"kind" must be "${INVENTORY_KIND}"`)
  const edition = idField(record.edition, 'edition')
  const collection_id = idField(record.collection_id, 'collection_id')
  const catalog_uri = httpsField(record.catalog_uri, 'catalog_uri', true)
  const mint = httpsField(record.mint, 'mint', false)
  const at = record.at
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0)
    fail('"at" must be a non-negative integer of unix seconds')
  const entries: unknown[] = Array.isArray(record.cards)
    ? record.cards
    : fail('"cards" must be an array')
  if (entries.length > MAX_INVENTORY_CARDS)
    fail(`"cards" holds more than ${MAX_INVENTORY_CARDS} entries`)

  const cards: InventoryCard[] = []
  let previous = ''
  for (const [index, entry] of entries.entries()) {
    const card: Record<string, unknown> = isRecord(entry)
      ? entry
      : fail(`card ${index} is not an object`)
    exactFields(card, CARD_FIELDS, `card ${index}`)
    const asset_id = idField(card.asset_id, 'asset_id')
    const count = card.count
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
      fail(`card ${asset_id} needs a positive integer "count"`)
    if (index > 0 && byId(previous, asset_id) >= 0)
      fail(`cards are not sorted by asset_id at ${asset_id}`)
    previous = asset_id
    cards.push({asset_id, count: count as number})
  }

  return {
    v: 1,
    kind: INVENTORY_KIND,
    edition,
    collection_id,
    catalog_uri,
    mint,
    at: at as number,
    cards
  }
}

/** Where an inventory goes: the shell's storage, and INC when there is one. */
export type InventoryOutlet = {
  storage: {
    setItem(key: string, value: string): Promise<void>
    removeItem?(key: string): Promise<void>
  }
  inc?: {emit(topic: string, payload: unknown): void}
}

/**
 * Take a stored inventory back, so the host never answers for this napplet
 * with counts it could not confirm, or with another wallet's. Removed where
 * the shell can remove, and emptied where it cannot; an empty value is not an
 * inventory to anyone.
 */
export async function withdrawInventory(
  outlet: Pick<InventoryOutlet, 'storage'>
): Promise<void> {
  for (const key of [INVENTORY_STORAGE_KEY, INVENTORY_WALLET_KEY])
    try {
      if (!outlet.storage.removeItem) throw new Error('no remove')
      await outlet.storage.removeItem(key)
    } catch {
      try {
        await outlet.storage.setItem(key, '')
      } catch {
        /* Nothing more a napplet can do; the cards on screen are unaffected. */
      }
    }
}

/**
 * Publish what the snapshot of one wallet holds, or withdraw what was
 * published before.
 *
 * The payload is stored only once it has been built and read back strictly,
 * then announced, with the name of the wallet it was counted from written
 * first. A snapshot that does not make a valid inventory, or a store that
 * refuses either, takes the previous one away instead of leaving it standing.
 * Resolves to what was published, or `null`.
 */
export async function publishInventory(
  outlet: InventoryOutlet,
  edition: CollectionEdition,
  snapshot: Snapshot,
  now: number,
  wallet: string
): Promise<Inventory | null> {
  let built: Inventory
  try {
    built = buildInventory(edition, snapshot, now)
    await outlet.storage.setItem(INVENTORY_WALLET_KEY, wallet)
    await outlet.storage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(built))
  } catch {
    await withdrawInventory(outlet)
    return null
  }
  try {
    outlet.inc?.emit(INVENTORY_CONVENTION, built)
  } catch {
    /* The stored copy stands; the host can still answer from it. */
  }
  return built
}

/** Whether a payload asks for the inventory of exactly this edition. */
export function isInventoryRequest(
  value: unknown,
  edition: string
): value is InventoryRequest {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.kind === INVENTORY_REQUEST_KIND &&
    value.edition === edition
  )
}

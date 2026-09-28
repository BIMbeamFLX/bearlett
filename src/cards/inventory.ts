// What the 600B TCG may know about a holder's cards: `nutft/inventory` v1,
// the payload the Hangar answers the game's `collection` intent with
// (nappelin apps/hangar/src/inventory.ts, TCG site/napplet.js). Counts per
// card and nothing else: no states, no keys. The name stays from the NutFT
// days; the Hangar and the game check the shape, not where cards live.

export const INVENTORY_KIND = 'nutft/inventory'
/** The storage key the Hangar reads a collection app's inventory from. */
export const INVENTORY_KEY = 'inventory'
const MAX_CARDS = 4096
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type Inventory = {
  v: 1
  kind: typeof INVENTORY_KIND
  edition: string
  collection_id: string
  catalog_uri: string
  mint: string
  /** unix seconds */
  at: number
  /** sorted by asset_id, in code-unit order, each once */
  cards: {asset_id: string; count: number}[]
}

const isHttps = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

/**
 * Counts the cards a holder holds by their name (the card's id in its
 * collection). Null when the Hangar would refuse it: a mint that is not
 * https, or a name no reader accepts.
 */
export const buildInventory = (
  pack: {edition: string; collection_id: string; catalog_uri: string},
  mint: string,
  names: string[],
  now: number
): Inventory | null => {
  if (!NAME.test(pack.edition) || !NAME.test(pack.collection_id)) return null
  if (pack.catalog_uri !== '' && !isHttps(pack.catalog_uri)) return null
  if (!isHttps(mint) || mint.length > 2048) return null
  const counts = new Map<string, number>()
  for (const name of names)
    if (NAME.test(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
  if (counts.size > MAX_CARDS) return null
  // code-unit order: a locale-aware sort would differ between readers
  const ids = [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    v: 1,
    kind: INVENTORY_KIND,
    edition: pack.edition,
    collection_id: pack.collection_id,
    catalog_uri: pack.catalog_uri,
    mint,
    at: Math.floor(now / 1000),
    cards: ids.map(asset_id => ({asset_id, count: counts.get(asset_id)!}))
  }
}

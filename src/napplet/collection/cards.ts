/**
 * The card model the collection screen renders.
 *
 * Everything here is pure. The wallet's `snapshot()` returns proofs, catalogue
 * entries and mint states; this turns that into stacks, counters and an order,
 * with no network, no storage and no host. That is what makes it testable, and
 * the grid is the part most likely to be wrong in a way nobody notices.
 */

/** One catalogue entry, as the mint publishes it. */
export type CardAsset = {
  asset_id: string
  name: string
  tier: string
  type_line: string
  /** How many of this card exist across the whole edition. */
  copies: number
  face: {
    sha256: string
    mime: string
    bytes: number
    urls: readonly string[]
  }
  asset_binding: string
}

/** One held card: a proof, its catalogue entry, and what the mint says. */
export type OwnedItem = {
  asset: CardAsset
  /** The curve point that identifies this proof at the mint. */
  Y: string
  state?: string
  proof?: unknown
  tag?: readonly string[]
}

/** What the wallet's `snapshot()` resolves to. */
export type Snapshot = {
  catalog: {
    collection_id?: string
    census_sha256?: string
    catalog_uri?: string
    /** The catalogue signer, x-only hex. The supply ledger is signed with it. */
    issuer_pubkey?: string
    assets?: readonly CardAsset[]
  } | null
  owned: readonly OwnedItem[]
  spent: readonly OwnedItem[]
  invalid: readonly {error?: string}[]
  unreadable: readonly unknown[]
}

/** Copies of one card, held together so the grid can show `×N`. */
export type CardStack = {
  asset: CardAsset
  count: number
  items: readonly OwnedItem[]
}

export type CollectionCounters = {
  cards: number
  distinct: number
  duplicates: number
}

/**
 * Two buckets, kept apart on purpose.
 *
 * An invalid proof is one this mint has an opinion about and rejects. An
 * unreadable token is one it cannot even open, which usually means the card
 * belongs to a different edition. Folding them together tells someone their
 * card is bad when the truth is that they are looking at the wrong collection.
 */
export type NotShown = {
  invalid: number
  unreadable: number
  reasons: readonly string[]
}

export type CollectionView = {
  collectionId: string | null
  stacks: readonly CardStack[]
  counters: CollectionCounters
  notShown: NotShown
  /** Tier names, rarest first, for the filter console. */
  tiers: readonly string[]
  /** Type lines present in the held cards, alphabetical. */
  types: readonly string[]
}

/**
 * Rarest first.
 *
 * Scarcity is taken from `copies`, which the catalogue states outright, rather
 * than from a hardcoded ranking of tier names. A ranking would be one more
 * thing to keep in step with an edition, and a new edition that invents a tier
 * would quietly sort it last.
 */
const byRarity = (a: CardStack, b: CardStack): number =>
  a.asset.copies - b.asset.copies ||
  a.asset.name.localeCompare(b.asset.name) ||
  a.asset.asset_id.localeCompare(b.asset.asset_id)

/** Tier names ordered by the scarcest card each one contains. */
export function tierOrder(assets: readonly CardAsset[]): string[] {
  const scarcest = new Map<string, number>()
  for (const asset of assets) {
    const seen = scarcest.get(asset.tier)
    if (seen === undefined || asset.copies < seen)
      scarcest.set(asset.tier, asset.copies)
  }
  return [...scarcest.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([tier]) => tier)
}

/** Group held cards into stacks and count them. */
export function buildCollectionView(snapshot: Snapshot): CollectionView {
  const stacks = new Map<string, {asset: CardAsset; items: OwnedItem[]}>()
  for (const item of snapshot.owned) {
    if (!item?.asset?.asset_id) continue
    const stack = stacks.get(item.asset.asset_id)
    if (stack) stack.items.push(item)
    else stacks.set(item.asset.asset_id, {asset: item.asset, items: [item]})
  }

  const list: CardStack[] = [...stacks.values()]
    .map(stack => ({
      asset: stack.asset,
      count: stack.items.length,
      items: stack.items
    }))
    .sort(byRarity)

  const cards = list.reduce((total, stack) => total + stack.count, 0)
  const reasons = [
    ...new Set(
      snapshot.invalid
        .map(entry => entry?.error)
        .filter((reason): reason is string => Boolean(reason))
    )
  ]

  return {
    collectionId: snapshot.catalog?.collection_id ?? null,
    stacks: list,
    counters: {
      cards,
      distinct: list.length,
      /* A duplicate is a copy beyond the first, not a card that has any. */
      duplicates: cards - list.length
    },
    notShown: {
      invalid: snapshot.invalid.length,
      unreadable: snapshot.unreadable.length,
      reasons
    },
    tiers: tierOrder(list.map(stack => stack.asset)),
    types: [...new Set(list.map(stack => stack.asset.type_line))].sort((a, b) =>
      a.localeCompare(b)
    )
  }
}

export type CardFilter = {
  /** Matched against name, type line and asset id, case-insensitively. */
  search?: string
  tier?: string
  type?: string
  /** Show only cards held more than once. */
  duplicatesOnly?: boolean
}

/** Narrow the grid. An absent or empty field is not a filter. */
export function filterStacks(
  stacks: readonly CardStack[],
  filter: CardFilter
): CardStack[] {
  const needle = filter.search?.trim().toLowerCase() ?? ''
  return stacks.filter(stack => {
    if (filter.tier && stack.asset.tier !== filter.tier) return false
    if (filter.type && stack.asset.type_line !== filter.type) return false
    if (filter.duplicatesOnly && stack.count < 2) return false
    if (!needle) return true
    return (
      stack.asset.name.toLowerCase().includes(needle) ||
      stack.asset.type_line.toLowerCase().includes(needle) ||
      stack.asset.asset_id.toLowerCase().includes(needle)
    )
  })
}

/**
 * How likely this card is in a pack, as one in N.
 *
 * Shown on the card back rather than in the grid. It is a ratio of stated
 * copies, not a probability the mint publishes, so it is named for what it is.
 */
export function scarcityRatio(
  asset: CardAsset,
  catalog: readonly CardAsset[]
): number | null {
  const total = catalog.reduce((sum, entry) => sum + (entry.copies || 0), 0)
  if (!total || !asset.copies) return null
  return Math.round(total / asset.copies)
}

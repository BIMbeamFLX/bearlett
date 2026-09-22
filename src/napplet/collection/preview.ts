import type {CardAsset} from './cards'

/**
 * The card named inside a NutFT proof secret.
 *
 * The secret is `["P2PK", { tags: [["nutft", "1", collection, asset, ...]] }]`.
 * This returns the asset id only. It never returns the secret.
 */
export function nutftAssetId(secret: string): string | null {
  try {
    const parsed = JSON.parse(secret) as unknown
    if (!Array.isArray(parsed) || parsed[0] !== 'P2PK') return null
    const body = parsed[1] as {tags?: unknown} | null
    if (!body || !Array.isArray(body.tags)) return null
    const tag = body.tags.find(
      entry => Array.isArray(entry) && entry[0] === 'nutft'
    ) as unknown[] | undefined
    if (!tag || tag[1] !== '1' || typeof tag[3] !== 'string' || !tag[3])
      return null
    return tag[3]
  } catch {
    return null
  }
}

export type CardPreview = {
  assetId: string
  name: string
  tier: string
  face: CardAsset['face'] | null
}

/** Names for a token's proofs, from the catalogue when it has them. */
export function previewsFromSecrets(
  secrets: readonly string[],
  catalog: readonly CardAsset[]
): CardPreview[] {
  return secrets.map(secret => {
    const assetId = nutftAssetId(secret) ?? ''
    const asset = assetId
      ? catalog.find(entry => entry.asset_id === assetId)
      : undefined
    return {
      assetId,
      name: asset?.name ?? 'Card from this collection',
      tier: asset?.tier ?? '',
      face: asset?.face ?? null
    }
  })
}

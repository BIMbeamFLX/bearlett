import type {CardAsset, CardStack} from './cards'

/** One copy a holder can choose to hand over. The secret stays off the screen. */
export type CopyRef = {
  y: string
  secret: string
  assetId: string
  name: string
  tier: string
  index: number
  of: number
  face: CardAsset['face']
}

const secretOf = (proof: unknown): string => {
  if (!proof || typeof proof !== 'object') return ''
  const secret = (proof as {secret?: unknown}).secret
  return typeof secret === 'string' ? secret : ''
}

/** Copies of the selected stacks, in stack order. Copies without a secret are skipped. */
export function copyRefs(
  stacks: readonly CardStack[],
  assetIds: readonly string[]
): CopyRef[] {
  const wanted = new Set(assetIds)
  const refs: CopyRef[] = []
  for (const stack of stacks) {
    if (!wanted.has(stack.asset.asset_id)) continue
    stack.items.forEach((item, index) => {
      const secret = secretOf(item.proof)
      if (!secret) return
      refs.push({
        y: item.Y,
        secret,
        assetId: stack.asset.asset_id,
        name: stack.asset.name,
        tier: stack.asset.tier,
        index: index + 1,
        of: stack.count,
        face: stack.asset.face
      })
    })
  }
  return refs
}

/** The first copy of each selected card. A stack is never sent whole by default. */
export function defaultPicks(copies: readonly CopyRef[]): string[] {
  const seen = new Set<string>()
  const picks: string[] = []
  for (const copy of copies) {
    if (seen.has(copy.assetId)) continue
    seen.add(copy.assetId)
    picks.push(copy.y)
  }
  return picks
}

export function togglePick(picks: readonly string[], y: string): string[] {
  return picks.includes(y) ? picks.filter(other => other !== y) : [...picks, y]
}

export type HandoverLine = {
  name: string
  sending: number
  staying: number
}

/** How many copies of each name leave, and how many stay. */
export function handoverLines(
  copies: readonly CopyRef[],
  picks: readonly string[]
): HandoverLine[] {
  const chosen = new Set(picks)
  const lines = new Map<string, HandoverLine>()
  for (const copy of copies) {
    const line = lines.get(copy.assetId) ?? {
      name: copy.name,
      sending: 0,
      staying: 0
    }
    if (chosen.has(copy.y)) line.sending += 1
    else line.staying += 1
    lines.set(copy.assetId, line)
  }
  return [...lines.values()].filter(line => line.sending > 0)
}

export function pickedCopies(
  copies: readonly CopyRef[],
  picks: readonly string[]
): CopyRef[] {
  const chosen = new Set(picks)
  return copies.filter(copy => chosen.has(copy.y))
}

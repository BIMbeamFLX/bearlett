import type {Bearer} from './storage'

// Coin selection for a LUD-25 internal transfer (25.md, "Internal transfer"):
// an exact match needs no split at all, so it is strictly better than
// accumulating past the target and minting leftover change. A single
// matching note is a free rotate ("a plain rotate is free"), and the
// everything-held case still avoids a split's change note and its fee.
// Only those two exact cases are checked (one note, or everything
// available) rather than searching every subset for one that happens to
// sum exactly; a general subset-sum search is overkill for a handful of
// notes per mint, and the plain accumulate-in-order walk always finds a
// usable selection when no exact one exists. The caller checks that the
// picked total covers the amount.
export const pickInternalTransferBearers = (
  available: Bearer[],
  msat: number
): Bearer[] => {
  const exact = available.find(b => b.amount === msat)
  if (exact) return [exact]
  const total = available.reduce((sum, b) => sum + b.amount, 0)
  if (total === msat) return available
  const picked: Bearer[] = []
  let running = 0
  for (const bearer of available) {
    if (running >= msat) break
    picked.push(bearer)
    running += bearer.amount
  }
  return picked
}

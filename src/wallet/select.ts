// Picking the notes one mint call spends. A split may take many notes at
// once (Redeeming a note), so one request reaches any amount the notes at a
// mint cover, as long as the request stays within URL limits.
import type {Note} from './state.ts'

/** ck1s cost about 168 URL bytes each: keep a request well under 2000. */
export const MAX_INPUTS = 8

export type Selection =
  /** one note worth exactly the amount: rotate or melt it as it is */
  | {mode: 'exact'; inputs: Note[]}
  /** notes worth more: split off the amount, the rest (minus the base fee) is change */
  | {mode: 'split'; inputs: Note[]; totalMsat: number}

/**
 * `baseFeeMsat` comes out of a split's change (Mint fees for split and
 * merge), and change must be worth at least 1 msat after it.
 */
export const selectNotes = (
  notes: Note[],
  amountMsat: number,
  baseFeeMsat = 0
): Selection | null => {
  const exact = notes.find(note => note.amountMsat === amountMsat)
  if (exact) return {mode: 'exact', inputs: [exact]}
  const needed = amountMsat + baseFeeMsat + 1
  const inputs: Note[] = []
  let totalMsat = 0
  for (const note of [...notes].sort((a, b) => b.amountMsat - a.amountMsat)) {
    if (totalMsat >= needed || inputs.length >= MAX_INPUTS) break
    inputs.push(note)
    totalMsat += note.amountMsat
  }
  return totalMsat >= needed ? {mode: 'split', inputs, totalMsat} : null
}

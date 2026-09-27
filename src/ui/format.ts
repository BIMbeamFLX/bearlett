// Amounts are msat inside the wallet and whole sats on screen.

const sats = new Intl.NumberFormat('en-US', {maximumFractionDigits: 3})

export const formatSats = (msat: number): string =>
  `${sats.format(msat / 1000)} sat`

/** Whole sats typed by the user, or null. */
export const parseSats = (text: string): number | null => {
  const value = Number(text.replace(/[\s,_']/g, ''))
  return Number.isSafeInteger(value) && value > 0 ? value * 1000 : null
}

/** An allotment in the unit a person thinks in. */
export const formatAllotment = (amount: number, metric: string): string => {
  if (metric === 'bytes') {
    const units: [number, string][] = [
      [1e9, 'GB'],
      [1e6, 'MB'],
      [1e3, 'kB']
    ]
    const [size, unit] = units.find(([size]) => amount >= size) ?? [1, 'bytes']
    return `${+(amount / size).toFixed(1)} ${unit}`
  }
  if (amount >= 3_600_000) return `${+(amount / 3_600_000).toFixed(1)} h`
  if (amount >= 60_000) return `${+(amount / 60_000).toFixed(1)} min`
  return `${Math.round(amount / 1000)} s`
}

export const formatTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short'
  })

export const shorten = (text: string, keep = 10): string =>
  text.length > keep * 2 + 1
    ? `${text.slice(0, keep)}…${text.slice(-keep)}`
    : text

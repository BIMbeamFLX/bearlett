// Amounts are msat inside the wallet and whole sats on screen.

const sats = new Intl.NumberFormat('en-US', {maximumFractionDigits: 3})

export const formatSats = (msat: number): string =>
  `${sats.format(msat / 1000)} sat`

/** Whole sats typed by the user, or null. */
export const parseSats = (text: string): number | null => {
  const value = Number(text.replace(/[\s,_']/g, ''))
  return Number.isSafeInteger(value) && value > 0 ? value * 1000 : null
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

/** Said on the first screen and under the balance: the wallet and its mints are new. */
export const EXPERIMENT =
  'An experiment: funds in this wallet are not safe. Keep only what you can afford to lose.'

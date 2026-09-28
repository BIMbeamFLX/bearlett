// The few BOLT-11 fields a wallet needs to remember a payment it made: the
// payment hash, when the invoice was made and how long it can be paid. The
// signature and everything else are the paying mint's to check.
import {bech32} from '@scure/base'
import {bytesToHex} from '../spec/bytes.ts'
import {invoiceText} from './links.ts'

export type InvoiceTerms = {
  /** hex */
  paymentHash: string
  /** unix seconds */
  timestamp: number
  /** seconds after the timestamp the invoice can be paid; Infinity if too long to read */
  expiry: number
}

/** BOLT-11: 7 words of timestamp first, a 104-word signature last. */
const TIMESTAMP_WORDS = 7
const SIGNATURE_WORDS = 104
const PAYMENT_HASH = 1
const EXPIRY = 6
const DEFAULT_EXPIRY = 3600

const wordsToNumber = (words: number[]): number =>
  words.reduce((value, word) => value * 32 + word, 0)

/** The invoice's payment hash, timestamp and expiry; null if it is not BOLT-11. */
export const invoiceTerms = (invoice: string): InvoiceTerms | null => {
  let words: number[]
  try {
    words = bech32.decode(
      invoiceText(invoice) as `${string}1${string}`,
      false
    ).words
  } catch {
    return null
  }
  const data = words.slice(0, words.length - SIGNATURE_WORDS)
  if (data.length < TIMESTAMP_WORDS) return null
  const timestamp = wordsToNumber(data.slice(0, TIMESTAMP_WORDS))
  let paymentHash: string | null = null
  let expiry = DEFAULT_EXPIRY
  let expirySeen = false
  for (let at = TIMESTAMP_WORDS; at < data.length;) {
    if (at + 3 > data.length) return null
    const type = data[at]
    const length = data[at + 1] * 32 + data[at + 2]
    const field = data.slice(at + 3, at + 3 + length)
    if (field.length !== length) return null
    // a payment hash of another length is one a reader skips (BOLT-11)
    if (type === PAYMENT_HASH && length === 52 && paymentHash === null) {
      const hash = bech32.fromWordsUnsafe(field)
      if (!hash) return null
      paymentHash = bytesToHex(hash)
    }
    // the first expiry counts, as LND reads it; one longer than 10 words
    // fits no number exactly, and is taken as never expiring
    if (type === EXPIRY && !expirySeen) {
      expirySeen = true
      expiry = length <= 10 ? wordsToNumber(field) : Infinity
    }
    at += 3 + length
  }
  return paymentHash ? {paymentHash, timestamp, expiry} : null
}

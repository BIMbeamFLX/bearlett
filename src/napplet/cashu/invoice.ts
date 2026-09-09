import {bech32} from '@scure/base'
import {decodeBolt11AmountMsat, decodeBolt11PaymentHash} from '../../lnurlcash'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex} from '@noble/hashes/utils.js'

/** BOLT11 signs the HRP and padded five-bit data before the signature. */
export function invoiceDigest(prefix: string, words: number[]): Uint8Array {
  let bits = 0,
    buffer = 0
  const bytes: number[] = []
  for (const word of words) {
    buffer = (buffer << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
    }
  }
  if (bits) bytes.push((buffer << (8 - bits)) & 255)
  return sha256(new Uint8Array([...new TextEncoder().encode(prefix), ...bytes]))
}

/** Bind a checksummed, fixed-amount invoice to an unexpired payment request. */
export function invoiceAmount(invoice: string, now = Date.now()): number {
  const decoded = bech32.decode(invoice as `${string}1${string}`, 4096)
  const words = decoded.words,
    end = words.length - 104
  const amount = decodeBolt11AmountMsat(invoice)
  if (
    end < 7 ||
    !amount ||
    !Number.isSafeInteger(amount) ||
    !decodeBolt11PaymentHash(invoice)
  )
    throw new Error('Use a valid fixed-amount BOLT11 invoice.')
  const number = (part: number[]) => part.reduce((v, word) => v * 32 + word, 0)
  const timestamp = number(words.slice(0, 7))
  let expiry = 3600,
    hasExpiry = false,
    hashes = 0
  let payee: string | undefined
  for (let i = 7; i < end;) {
    if (i + 3 > end) throw new Error('Invalid invoice field.')
    const tag = words[i],
      length = words[i + 1] * 32 + words[i + 2]
    if (i + 3 + length > end) throw new Error('Invalid invoice field.')
    if (tag === 1) hashes++
    if (tag === 19) {
      if (payee || length !== 53) throw new Error('Invalid invoice payee.')
      payee = bytesToHex(bech32.fromWords(words.slice(i + 3, i + 3 + length)))
    }
    if (tag === 6) {
      if (hasExpiry) throw new Error('Duplicate invoice expiry.')
      hasExpiry = true
      expiry = number(words.slice(i + 3, i + 3 + length))
    }
    i += 3 + length
  }
  if (!Number.isSafeInteger(expiry) || (timestamp + expiry) * 1000 <= now)
    throw new Error('Invoice has expired.')
  if (hashes !== 1) throw new Error('Invoice must contain one payment hash.')
  const signature = bech32.fromWords(words.slice(end))
  const recovered = new Uint8Array([signature[64], ...signature.slice(0, 64)])
  const digest = invoiceDigest(decoded.prefix, words.slice(0, end))
  const publicKey = secp256k1.recoverPublicKey(recovered, digest, {
    prehash: false
  })
  if (
    (payee && payee !== bytesToHex(publicKey)) ||
    !secp256k1.verify(signature.slice(0, 64), digest, publicKey, {
      prehash: false,
      lowS: false
    })
  )
    throw new Error('Invalid invoice signature.')
  return amount
}

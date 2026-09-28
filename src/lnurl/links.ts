// What a user pastes or scans, and the note links the wallet hands out.
// LUD-01 bech32 LNURLs, LUD-16 Lightning Addresses, LUD-17 schemes, BOLT-11
// invoices and LUD-25 note links all arrive through here.
import {bech32} from '@scure/base'
import {decodeAmount, decodeCp1, decodeCs1} from '../spec/encoding.ts'
import {decodeSpend} from '../spec/notes.ts'
import {isAllowedServiceUrl, plainHttpHost} from './net.ts'

const LUD17 = /^(lnurlw|lnurlp|lnurlc|keyauth):\/\//i

/** LUD-17: a scheme-prefixed LNURL is https, or http where net.ts allows it. */
export const fromLud17 = (url: string): string => {
  const match = LUD17.exec(url)
  if (!match) return url
  const rest = url.slice(match[0].length)
  let hostname = ''
  try {
    hostname = new URL(`https://${rest}`).hostname
  } catch {
    return url
  }
  return `${plainHttpHost(hostname) ? 'http' : 'https'}://${rest}`
}

/** The lnurlw:// form of a withdraw URL where LUD-17 maps it back exactly. */
export const toLnurlw = (url: string): string => {
  const parsed = new URL(url)
  const scheme = plainHttpHost(parsed.hostname) ? 'http:' : 'https:'
  if (parsed.protocol !== scheme) return url
  return `lnurlw://${url.slice(parsed.protocol.length + 2)}`
}

/** LUD-01: a bech32 LNURL decodes to its URL, or null. */
export const decodeLnurl = (value: string): string | null => {
  const text = value.trim()
  if (!/^lnurl1/i.test(text)) return null
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return null
  try {
    const {prefix, words} = bech32.decode(text.toLowerCase(), false)
    if (prefix !== 'lnurl') return null
    return new TextDecoder().decode(bech32.fromWords(words))
  } catch {
    return null
  }
}

export const encodeLnurl = (url: string): string =>
  bech32
    .encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), false)
    .toUpperCase()

/** LUD-16: user@host names <scheme>://host/.well-known/lnurlp/user. */
export const lightningAddressUrl = (address: string): string | null => {
  const match = /^([a-z0-9._+-]+)@([a-z0-9.-]+(?::\d+)?)$/i.exec(address.trim())
  if (!match) return null
  const [, user, host] = match
  let hostname: string
  try {
    hostname = new URL(`https://${host}`).hostname
  } catch {
    return null
  }
  if (!hostname.includes('.') && !plainHttpHost(hostname)) return null
  const scheme = plainHttpHost(hostname) ? 'http' : 'https'
  return `${scheme}://${host.toLowerCase()}/.well-known/lnurlp/${user.toLowerCase()}`
}

/**
 * Any LNURL a user hands over, as the URL to fetch: a bech32 LNURL, a LUD-17
 * scheme, a Lightning Address, or a plain URL, each admitted by net.ts.
 */
export const resolveLnurlInput = (input: string): string | null => {
  const text = input.trim().replace(/^lightning:/i, '')
  if (!text) return null
  const url = decodeLnurl(text) ?? lightningAddressUrl(text) ?? fromLud17(text)
  return isAllowedServiceUrl(url) ? url : null
}

/**
 * A mint to add: its Lightning Address or LNURL, or (Bearlett's shorthand)
 * a bare domain for its `_` identity. A raw URL is not a mint address: it
 * may as well be a note.
 */
export const resolveMintInput = (input: string): string | null => {
  const text = input.trim()
  if (!text) return null
  const url = decodeLnurl(text) ?? lightningAddressUrl(text)
  if (url) return isAllowedServiceUrl(url) ? url : null
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(text))
    return lightningAddressUrl(`_@${text}`)
  return null
}

// ---- LUD-25 note links ----

export type NoteLink = {
  /** the withdraw LNURL without k1, amount or c */
  endpoint: string
  k1: string
  /** declared, unauthoritative: only the informational GET counts */
  amountMsat?: number
  c?: string
}

// `sig` is the certificate's name before lnurl/luds 50d740a, still read
const NOTE_PARAMS = ['k1', 'amount', 'c', 'sig']

/**
 * Redeeming a note: `<withdraw LNURL>?k1=<spend>[&amount=<msat>][&c=<cs1>]`.
 * The k1 must be a spend (a bearer preimage, ck1 or cw1); both are bytes,
 * so casing is dropped and one secret in two casings is one note.
 */
export const parseNoteLink = (input: string): NoteLink | null => {
  const url = resolveLnurlInput(input)
  if (!url) return null
  const parsed = new URL(url)
  const k1 = parsed.searchParams.get('k1')?.trim().toLowerCase()
  if (!k1 || !decodeSpend(k1)) return null
  const c =
    parsed.searchParams.get('c') ?? parsed.searchParams.get('sig') ?? undefined
  const declared = Number(parsed.searchParams.get('amount') ?? NaN)
  for (const name of NOTE_PARAMS) parsed.searchParams.delete(name)
  return {
    endpoint: parsed.toString(),
    k1,
    amountMsat:
      Number.isSafeInteger(declared) && declared > 0
        ? declared
        : c
          ? decodeCs1(c)?.amountMsat
          : undefined,
    c
  }
}

/** A note link in lnurlw:// form, carrying the amount inside `c` if any. */
export const buildNoteLink = (link: NoteLink): string => {
  const url = new URL(link.endpoint)
  for (const name of NOTE_PARAMS) url.searchParams.delete(name)
  // a spend is bytes: one casing, so one secret is one link
  url.searchParams.set('k1', link.k1.toLowerCase())
  // a cs1 already carries the amount in its human-readable part
  if (link.c) url.searchParams.set('c', link.c)
  else if (link.amountMsat)
    url.searchParams.set('amount', String(link.amountMsat))
  return toLnurlw(url.toString())
}

// ---- BOLT-11 ----

// the amount is all a wallet reads here: the mint that pays checks the rest
const INVOICE = /^ln(bcrt|bc|tbs|tb|sb)(\d*[munp]?)1[0-9a-z]+$/

/** An invoice as the wallet compares it: trimmed, without lightning:, lowercase. */
export const invoiceText = (text: string): string =>
  text
    .trim()
    .replace(/^lightning:/i, '')
    .toLowerCase()

/** Whether the text is a BOLT-11 invoice (optionally lightning:-prefixed). */
export const isInvoice = (text: string): boolean =>
  INVOICE.test(invoiceText(text))

/** The amount a BOLT-11 invoice asks for, from its human-readable part. */
export const invoiceAmountMsat = (invoice: string): number | null => {
  const match = INVOICE.exec(invoiceText(invoice))
  if (!match || !match[2]) return null
  return decodeAmount(match[2])
}

// ---- anything pasted or scanned ----

export type Input =
  | {kind: 'note'; link: NoteLink}
  | {kind: 'invoice'; invoice: string}
  | {kind: 'lnurl'; url: string}
  | {kind: 'cp1'; q: Uint8Array; cp1: string}

/** Sorts a pasted or scanned string into what the wallet can act on. */
export const classifyInput = (input: string): Input | null => {
  const text = input.trim().replace(/^lightning:/i, '')
  if (!text) return null
  if (isInvoice(text)) return {kind: 'invoice', invoice: invoiceText(text)}
  const q = decodeCp1(text)
  if (q) return {kind: 'cp1', q, cp1: text.toLowerCase()}
  const link = parseNoteLink(text)
  if (link) return {kind: 'note', link}
  const url = resolveLnurlInput(text)
  return url ? {kind: 'lnurl', url} : null
}

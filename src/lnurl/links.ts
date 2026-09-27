// What a user pastes or scans, and the note links the wallet hands out.
// LUD-01 bech32 LNURLs, LUD-16 Lightning Addresses, LUD-17 schemes, BOLT-11
// invoices and LUD-25 note links all arrive through here.
import {bech32} from '@scure/base'
import {decodeAmount, decodeCp1} from '../spec/encoding.ts'

const LUD17 = /^(lnurlw|lnurlp|lnurlc|keyauth):\/\//i

/** LUD-17: a scheme-prefixed LNURL is https (http for onion services). */
export const fromLud17 = (url: string): string => {
  const match = LUD17.exec(url)
  if (!match) return url
  const rest = url.slice(match[0].length)
  const host = rest.split(/[/?#]/)[0].split(':')[0]
  return `${host.endsWith('.onion') ? 'http' : 'https'}://${rest}`
}

/** The lnurlw:// form of an https (or onion) withdraw URL, else the URL. */
export const toLnurlw = (url: string): string => {
  const parsed = new URL(url)
  if (parsed.protocol === 'https:' || parsed.hostname.endsWith('.onion'))
    return `lnurlw://${url.slice(parsed.protocol.length + 2)}`
  return url
}

/** LUD-01: a bech32 LNURL decodes to its URL, or null. */
export const decodeLnurl = (value: string): string | null => {
  const text = value.trim()
  if (!/^lnurl1/i.test(text)) return null
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

/** LUD-16: user@host names https://host/.well-known/lnurlp/user. */
export const lightningAddressUrl = (address: string): string | null => {
  const match = /^([a-z0-9._+-]+)@([a-z0-9.-]+\.[a-z0-9-]+(:\d+)?)$/i.exec(
    address.trim()
  )
  if (!match) return null
  const [, user, host] = match
  const scheme = host.split(':')[0].endsWith('.onion') ? 'http' : 'https'
  return `${scheme}://${host.toLowerCase()}/.well-known/lnurlp/${user.toLowerCase()}`
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

const NOTE_PARAMS = ['k1', 'amount', 'c']

/** Redeeming a note: `<withdraw LNURL>?k1=<spend>[&amount=<msat>][&c=<cs1>]`. */
export const parseNoteLink = (input: string): NoteLink | null => {
  let text = input.trim().replace(/^lightning:/i, '')
  text = decodeLnurl(text) ?? fromLud17(text)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const k1 = url.searchParams.get('k1')
  if (!k1) return null
  const amount = Number(url.searchParams.get('amount'))
  const c = url.searchParams.get('c') ?? undefined
  for (const name of NOTE_PARAMS) url.searchParams.delete(name)
  return {
    endpoint: url.toString(),
    k1,
    amountMsat: Number.isSafeInteger(amount) && amount > 0 ? amount : undefined,
    c
  }
}

/** A note link in lnurlw:// form, carrying the amount inside `c` if any. */
export const buildNoteLink = (link: NoteLink): string => {
  const url = new URL(link.endpoint)
  for (const name of NOTE_PARAMS) url.searchParams.delete(name)
  url.searchParams.set('k1', link.k1)
  // a cs1 already carries the amount in its human-readable part
  if (link.c) url.searchParams.set('c', link.c)
  else if (link.amountMsat)
    url.searchParams.set('amount', String(link.amountMsat))
  return toLnurlw(url.toString())
}

// ---- BOLT-11 ----

const INVOICE = /^ln(bcrt|bc|tbs|tb|sb)(\d*[munp]?)1[02-9ac-hj-np-z]+$/

/** Whether the text is a BOLT-11 invoice (optionally lightning:-prefixed). */
export const isInvoice = (text: string): boolean =>
  INVOICE.test(
    text
      .trim()
      .replace(/^lightning:/i, '')
      .toLowerCase()
  )

/** The amount a BOLT-11 invoice asks for, from its human-readable part. */
export const invoiceAmountMsat = (invoice: string): number | null => {
  const match = INVOICE.exec(
    invoice
      .trim()
      .replace(/^lightning:/i, '')
      .toLowerCase()
  )
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
  if (isInvoice(text)) return {kind: 'invoice', invoice: text.toLowerCase()}
  const q = decodeCp1(text)
  if (q) return {kind: 'cp1', q, cp1: text.toLowerCase()}
  const link = parseNoteLink(text)
  if (link) return {kind: 'note', link}
  const address = lightningAddressUrl(text)
  if (address) return {kind: 'lnurl', url: address}
  const url = decodeLnurl(text) ?? fromLud17(text)
  if (/^https?:\/\//i.test(url)) return {kind: 'lnurl', url}
  return null
}

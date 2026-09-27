// Paying a TollGate (OpenTollGate/TollGate) with LNURLcash notes, per the
// draft TIP in docs/TOLLGATE-LNURLCASH-TIP.md: its signed advertisement
// (TIP-01 kind 10021) names the mints it accepts, and HTTP-01's POST / takes
// either a note link (by note) or `cp1<key>@<withdraw URL>` (by key).
import {decodeCp1, decodeCx1, type BranchExport} from '../spec/encoding.ts'
import {ProtocolError, TransportError} from '../lnurl/errors.ts'
import {fromLud17} from '../lnurl/links.ts'
import {isAllowedServiceUrl, plainHttpHost} from '../lnurl/net.ts'
import {isValidEvent, tagValues, type NostrEvent} from './nostr.ts'

export type Offer = {
  /** the accepted mint's withdraw endpoint, as endpointOf() writes it */
  mint: string
  priceMsat: number
  minSteps: number
  /** the TollGate's own branch at this mint, for paying by key */
  cpub?: {branch: BranchExport; index: number}
}

export type Advertisement = {
  /** the TollGate's identity, hex */
  pubkey: string
  metric: 'milliseconds' | 'bytes'
  stepSize: number
  offers: Offer[]
  event: NostrEvent
}

export type Session = {
  /** in the metric's unit: what this device may use now, in total */
  allotment: number
  metric: string
  event: NostrEvent
}

/** A TollGate answered with a TIP-01 notice instead of a session. */
export class TollGateNotice extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message || code)
    this.name = 'TollGateNotice'
    this.code = code
  }
}

export const HTTP_PORT = 2121
const UNITS: Record<string, number> = {sat: 1000, msat: 1}

const whole = (value: string | undefined): number => {
  if (!value || !/^\d+$/.test(value)) return NaN
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : NaN
}

/**
 * A withdraw endpoint as offers and notes are compared: LUD-17 schemes
 * resolved, query and fragment dropped. Null if no secret may go there.
 */
export const endpointOf = (url: string): string | null => {
  try {
    const parsed = new URL(fromLud17(url.trim()))
    parsed.search = ''
    parsed.hash = ''
    const endpoint = parsed.toString()
    return isAllowedServiceUrl(endpoint) ? endpoint : null
  } catch {
    return null
  }
}

/** `["lnurlcash_cpub", "<withdraw_url>", "<cx1>:<i>"]`, as LUD-25's text/cpub. */
const parseCpub = (hint: string | undefined): Offer['cpub'] => {
  const at = hint?.lastIndexOf(':') ?? -1
  if (!hint || at < 1) return undefined
  const branch = decodeCx1(hint.slice(0, at))
  const index = whole(hint.slice(at + 1))
  return branch && index < 2 ** 32 ? {branch, index} : undefined
}

/** Reads a TIP-01 advertisement; of its offers, only LNURLcash ones are kept. */
export const parseAdvertisement = (value: unknown): Advertisement => {
  if (!isValidEvent(value) || value.kind !== 10021)
    throw new ProtocolError(
      'This TollGate did not send a signed advertisement.'
    )
  const metric = tagValues(value, 'metric')?.[0]
  const stepSize = whole(tagValues(value, 'step_size')?.[0])
  if ((metric !== 'milliseconds' && metric !== 'bytes') || !(stepSize > 0))
    throw new ProtocolError('The advertisement names no metric or step size.')
  const cpubs = new Map<string, Offer['cpub']>()
  for (const [name, mint, hint] of value.tags) {
    const endpoint = name === 'lnurlcash_cpub' && mint && endpointOf(mint)
    if (endpoint) cpubs.set(endpoint, parseCpub(hint))
  }
  const offers: Offer[] = []
  for (const [name, asset, price, unit, mint, minSteps] of value.tags) {
    if (name !== 'price_per_step' || asset !== 'lnurlcash') continue
    const priceMsat = whole(price) * (UNITS[unit] ?? NaN)
    const endpoint = mint && endpointOf(mint)
    if (!(priceMsat > 0) || !Number.isSafeInteger(priceMsat) || !endpoint)
      continue
    offers.push({
      mint: endpoint,
      priceMsat,
      minSteps: whole(minSteps) || 0,
      cpub: cpubs.get(endpoint)
    })
  }
  return {pubkey: value.pubkey, metric, stepSize, offers, event: value}
}

/** What `steps` cost at an offer, at least its minimum purchase. */
export const priceMsat = (offer: Offer, steps: number): number =>
  offer.priceMsat * Math.max(steps, offer.minSteps, 1)

/** The steps a note worth `valueMsat` buys: TIP-02's whole-token rule. */
export const stepsFor = (offer: Offer, valueMsat: number): number =>
  Math.floor(valueMsat / offer.priceMsat)

/** By key: the note the customer made on the TollGate's key, and where. */
export const keyPaymentBody = (cp1: string, offer: Offer): string =>
  `${cp1}@${offer.mint}`

/** The TollGate's reading of a by-key body. */
export const parseKeyPayment = (
  body: string
): {q: Uint8Array; endpoint: string} | null => {
  const match = /^(cp1[0-9a-z]+)@(\S+)$/.exec(body.trim())
  const q = match && decodeCp1(match[1])
  const endpoint = match && endpointOf(match[2])
  return q && endpoint ? {q, endpoint} : null
}

/** A session, or the TollGate's notice as a thrown TollGateNotice. */
export const parsePaymentAnswer = (value: unknown, pubkey: string): Session => {
  if (!isValidEvent(value) || value.pubkey !== pubkey)
    throw new ProtocolError(
      'The TollGate answered with something it did not sign.'
    )
  if (value.kind === 21023)
    throw new TollGateNotice(
      tagValues(value, 'code')?.[0] ?? 'error',
      value.content
    )
  if (value.kind !== 1022)
    throw new ProtocolError(
      'The TollGate answered with neither a session nor a notice.'
    )
  const allotment = whole(tagValues(value, 'allotment')?.[0])
  if (!(allotment >= 0))
    throw new ProtocolError('The session names no allotment.')
  return {
    allotment,
    metric: tagValues(value, 'metric')?.[0] ?? '',
    event: value
  }
}

/**
 * Where a TollGate is asked: https anywhere; plain http on this machine, on
 * the private network it sells access to (RFC 1918, link-local), or at a
 * .fips or .onion name.
 */
export const isTollGateUrl = (url: string): boolean => {
  try {
    const {protocol, hostname} = new URL(url)
    if (protocol === 'https:') return true
    return (
      protocol === 'http:' &&
      (plainHttpHost(hostname) ||
        /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(
          hostname
        ))
    )
  } catch {
    return false
  }
}

/** What a user types, as HTTP-01's root: `192.168.1.1` is http://192.168.1.1:2121/. */
export const tollGateUrl = (input: string): string | null => {
  const text = input.trim()
  if (!text) return null
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`)
    if (!url.port && url.protocol === 'http:') url.port = String(HTTP_PORT)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return isTollGateUrl(url.toString()) ? url.toString() : null
  } catch {
    return null
  }
}

export type TollGateHttp = {
  get(url: string): Promise<unknown>
  post(url: string, body: string): Promise<unknown>
}

const MAX_ANSWER_BYTES = 64 * 1024

const ask = async (url: string, init: RequestInit): Promise<unknown> => {
  if (!isTollGateUrl(url))
    throw new ProtocolError(`Not a TollGate address: ${url}`)
  let text: string
  try {
    const response = await fetch(url, {...init, redirect: 'error'})
    text = await response.text()
  } catch (err) {
    throw new TransportError(
      `No answer from the TollGate: ${(err as Error).message}`
    )
  }
  if (text.length > MAX_ANSWER_BYTES)
    throw new TransportError('The TollGate answer is too large.')
  try {
    return JSON.parse(text)
  } catch {
    throw new TransportError('The TollGate did not answer with an event.')
  }
}

/** HTTP-01 over fetch: GET / is the advertisement, POST / the payment. */
export const fetchTollGateHttp: TollGateHttp = {
  get: url => ask(url, {}),
  post: (url, body) =>
    ask(url, {
      method: 'POST',
      body,
      headers: {'content-type': 'text/plain'}
    })
}

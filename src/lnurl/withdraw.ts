// LUD-03 withdrawRequests as LUD-25 extends them: the informational GET
// (by spend, or by `?p=` without exposing it) and the callback's melt,
// rotate, split and merge.
import {secp256k1} from '@noble/curves/secp256k1.js'
import {ServiceError, TransportError} from './errors.ts'
import {requireServiceUrl, type Net} from './net.ts'

export type NoteInfo = {
  /** the callback, checked to be on the endpoint's own origin */
  callback: string
  /** the echoed k1, when queried by spend */
  k1?: string
  /** the authoritative value: maxWithdrawable */
  amountMsat: number
  mintPubkey?: string
  /** SERVICE's cs1 certificate for this note, if it gives one */
  c?: string
}

const withQuery = (base: string, entries: [string, string][]): string => {
  const url = requireServiceUrl(base)
  for (const [name, value] of entries) url.searchParams.append(name, value)
  return url.toString()
}

/**
 * The note's informational GET. By `k1` SERVICE verifies the spend in full
 * first; by `p` (a cp1 or a bearer note's hex h) it only looks the note up.
 * Neither burns anything.
 */
export const fetchNoteInfo = async (
  net: Net,
  endpoint: string,
  query: {k1: string} | {p: string},
  signal?: AbortSignal
): Promise<NoteInfo> => {
  const byK1 = 'k1' in query
  const url = withQuery(endpoint, [byK1 ? ['k1', query.k1] : ['p', query.p]])
  return parseNoteInfo(
    endpoint,
    query,
    await net.get(url, {signal, secret: byK1})
  )
}

const isMsat = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A 33-byte compressed secp256k1 point, as hex; anything else verifies nothing. */
const isCompressedPoint = (value: string): boolean => {
  if (!/^0[23][0-9a-f]{64}$/i.test(value)) return false
  try {
    secp256k1.Point.fromHex(value)
    return true
  } catch {
    return false
  }
}

/**
 * Checks an informational GET's answer for the note it was asked about. The
 * k1 must be echoed (casing aside: it is bytes), the value is the
 * authoritative maxWithdrawable, and a mintPubkey, when given, must be a
 * compressed key. A missing one is allowed: LUD-25 makes certifying a SHOULD,
 * so such a note is simply not checkable offline.
 */
export const parseNoteInfo = (
  endpoint: string,
  query: {k1: string} | {p: string},
  body: Record<string, unknown>
): NoteInfo => {
  const byK1 = 'k1' in query
  if (body.tag !== 'withdrawRequest' || typeof body.callback !== 'string')
    throw new TransportError('The mint did not answer with a withdrawRequest.')
  // a spend only ever travels to the origin that issued the note
  if (requireServiceUrl(body.callback).origin !== new URL(endpoint).origin)
    throw new TransportError('The mint named a callback on another origin.')
  if (
    byK1 &&
    (typeof body.k1 !== 'string' ||
      body.k1.toLowerCase() !== query.k1.toLowerCase())
  )
    throw new TransportError(
      'The mint did not echo the note it was asked about.'
    )
  const amount = body.maxWithdrawable
  if (!isMsat(amount))
    throw new TransportError('The mint gave no value for this note.')
  if (
    body.minWithdrawable !== undefined &&
    (!isMsat(body.minWithdrawable) || body.minWithdrawable > amount)
  )
    throw new TransportError('The mint gave a minimum above the note value.')
  let mintPubkey: string | undefined
  if (body.mintPubkey !== undefined && body.mintPubkey !== null) {
    if (
      typeof body.mintPubkey !== 'string' ||
      !isCompressedPoint(body.mintPubkey)
    )
      throw new TransportError(
        'The mint key is not a compressed secp256k1 key.'
      )
    mintPubkey = body.mintPubkey.toLowerCase()
  }
  return {
    callback: body.callback,
    k1: byK1 ? query.k1 : undefined,
    amountMsat: amount,
    mintPubkey,
    c: typeof body.c === 'string' ? body.c : undefined
  }
}

export type Certificates = {c?: string; c2?: string}

const certificates = (body: Record<string, unknown>): Certificates => ({
  c: typeof body.c === 'string' ? body.c : undefined,
  c2: typeof body.c2 === 'string' ? body.c2 : undefined
})

/**
 * Rotate (one k1), merge (many) or split (with `split`): every given note is
 * burned and p1 (and p2) minted. A retry of the exact same request is
 * answered as a replay, so a lost answer is safe to ask again.
 */
export const burn = async (
  net: Net,
  callback: string,
  k1s: string[],
  p1: string,
  split?: {amountMsat: number; p2: string},
  signal?: AbortSignal
): Promise<Certificates> => {
  if (!k1s.length) throw new ServiceError('Nothing to spend.')
  const query: [string, string][] = k1s.map(k1 => ['k1', k1])
  if (split) query.push(['amount', String(split.amountMsat)])
  query.push(['p1', p1])
  if (split) query.push(['p2', split.p2])
  const body = await net.get(withQuery(callback, query), {signal, secret: true})
  if (body.status !== 'OK')
    throw new TransportError('The mint did not confirm.')
  return certificates(body)
}

/**
 * LUD-03 melt: the note is burned once `pr` is paid. `pr` must be for the
 * note's exact value. Unlike a burn, a melt is not replayed, and "OK" only
 * means the payment is in flight.
 */
export const melt = async (
  net: Net,
  callback: string,
  k1: string,
  pr: string,
  signal?: AbortSignal
): Promise<{verify?: string}> => {
  const url = withQuery(callback, [
    ['k1', k1],
    ['pr', pr]
  ])
  const body = await net.get(url, {signal, secret: true})
  if (body.status !== 'OK')
    throw new TransportError('The mint did not confirm.')
  const verify = typeof body.verify === 'string' ? body.verify : undefined
  if (verify) requireServiceUrl(verify)
  return {verify}
}

// ---- lnurl-mint's username registration (not part of LUD-25's wire) ----

/** lnurl-mint serves its routes under the base its withdrawLink ends in /w. */
export const mintBaseOf = (withdrawLink: string): string => {
  const url = new URL(withdrawLink)
  url.search = ''
  url.pathname = url.pathname.replace(/\/w\/?$/, '')
  return url.toString().replace(/\/$/, '')
}

export const registerUsername = async (
  net: Net,
  withdrawLink: string,
  username: string,
  cx1: string,
  signature: string
): Promise<void> => {
  if (!net.send)
    throw new ServiceError(
      'Registering needs the web app: this host can only GET.'
    )
  const url = new URL(
    `${mintBaseOf(withdrawLink)}/p/${encodeURIComponent(username)}`
  )
  url.searchParams.set('cx1', cx1)
  url.searchParams.set('sig', signature)
  await net.send('POST', url.toString())
}

export const unregisterUsername = async (
  net: Net,
  withdrawLink: string,
  username: string,
  signature: string
): Promise<void> => {
  if (!net.send)
    throw new ServiceError(
      'Unregistering needs the web app: this host can only GET.'
    )
  const url = new URL(
    `${mintBaseOf(withdrawLink)}/p/${encodeURIComponent(username)}`
  )
  url.searchParams.set('sig', signature)
  await net.send('DELETE', url.toString())
}

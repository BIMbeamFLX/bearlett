// The one door to the network. The wallet core only ever asks for LNURL
// JSON; how the bytes travel (fetch in the web app, the shell's
// NAP-RESOURCE in the Hangar) is a port each platform plugs in, under
// src/platform: the napplet bundle must not carry fetch at all.
import {ProtocolError, ServiceError, TransportError} from './errors.ts'

export type RequestOptions = {
  signal?: AbortSignal
  /** the URL carries a bearer secret: never follow a redirect with it */
  secret?: boolean
}

export type Net = {
  /** GET an LNURL endpoint and return its JSON (LUD-01 errors thrown). */
  get(url: string, options?: RequestOptions): Promise<Record<string, unknown>>
  /**
   * POST or DELETE without a body, parameters in the query string - only
   * lnurl-mint's username registration needs it. Absent where the platform
   * can only GET (the Hangar's NAP-RESOURCE).
   */
  send?(
    method: 'POST' | 'DELETE',
    url: string,
    options?: RequestOptions
  ): Promise<Record<string, unknown>>
}

const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Hosts reached over plain http: this machine, onion services (LUD-01's
 * exception), and FIPS mesh endpoints. Onion and FIPS names are
 * self-authenticating: a `<npub>.fips` name is the endpoint's Nostr key, and
 * FIPS encrypts and authenticates it end to end (Noise XK), so TLS adds
 * nothing a certificate authority could vouch for. A bare fd00::/8 address
 * does not qualify: that is the general ULA range, not FIPS's own.
 */
export const plainHttpHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.onion') ||
    host.endsWith('.fips')
  )
}

/**
 * https everywhere, plain http only where plainHttpHost allows it: the same
 * admission rule for every URL a secret may travel in.
 */
export const isAllowedServiceUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && plainHttpHost(parsed.hostname)
  } catch {
    return false
  }
}

export const requireServiceUrl = (url: string): URL => {
  if (!isAllowedServiceUrl(url))
    throw new ProtocolError(`Refusing to contact ${url}: not https.`)
  return new URL(url)
}

/**
 * Parses an LNURL response body. LUD-01 makes HTTP status codes meaningless,
 * so only the JSON counts: an ERROR status becomes a ServiceError, anything
 * that is not a JSON object is a transport problem.
 */
export const parseLnurlJson = (text: string): Record<string, unknown> => {
  if (text.length > MAX_RESPONSE_BYTES)
    throw new TransportError('The response is too large.')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new TransportError('The service did not answer with JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new TransportError('The service answered with something unexpected.')
  const record = body as Record<string, unknown>
  if (
    typeof record.status === 'string' &&
    record.status.toUpperCase() === 'ERROR'
  )
    throw new ServiceError(
      typeof record.reason === 'string' ? record.reason : 'unspecified error'
    )
  return record
}

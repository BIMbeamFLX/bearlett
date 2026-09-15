import {NUTFT_OPERATIONS, nutftMintUrl} from '../../host/nutft-contract'
import type {NutftHost, NutftOperation} from '../../host/nutft-contract'

/**
 * The card wallet talks to its mint with plain `fetch`. A napplet has no
 * network: byte fetches go through NAP-RESOURCE and mint operations through the
 * NutFT capability. This router is what the napplet installs in place of the
 * global `fetch`, so no code path can reach the network another way.
 *
 * Two destinations, and nothing else:
 *
 *   - the collection's own mint, mapped to a named operation;
 *   - an allow-listed Blossom mirror, fetched as bytes.
 *
 * Anything else is refused here rather than at the host, so the error names the
 * napplet's own mistake instead of arriving as a denial.
 */

export type ResourceBytes = {
  bytes(url: string, options?: {signal?: AbortSignal}): Promise<Blob>
}

export type CollectionTransportOptions = {
  /** Canonical mint URL, path included: the G edition lives under `/g`. */
  mint: string
  nutft: NutftHost
  resource: ResourceBytes
  /** Blossom origins that may serve card faces and catalogue blobs. */
  mirrors: readonly string[]
  /** Card faces are capped by the wallet at 3 MB; the host caps them too. */
  maxBytes?: number
  /**
   * Told the name of each mint operation as it is sent, for progress on long
   * work such as a restore, and how long it waits before asking again. Never
   * the body, the parameter or the reply.
   */
  observe?: (operation: NutftOperation, detail?: {retryInMs?: number}) => void
  /** How to wait before asking the mint again. Tests pass one that does not. */
  sleep?: (ms: number) => Promise<void>
}

type Route =
  | {kind: 'operation'; operation: NutftOperation; parameter?: string}
  | {kind: 'mirror'; url: string}

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024

/**
 * The operations that change nothing at the mint, and so may simply be asked
 * again. Trades, sales and possession proofs are not here: the card library
 * keeps their pending outputs and decides itself when to send them again.
 */
const READ_ONLY: ReadonlySet<NutftOperation> = new Set([
  'info',
  'keys',
  'keysets',
  'catalog',
  'blob',
  'state',
  'supply',
  'checkstate',
  'restore'
])

/** Asked at most this often, waiting between tries as the mint asks. */
export const ATTEMPTS = 4
/** No single wait is longer than this, whatever the mint asks for. */
export const LONGEST_WAIT_MS = 20_000
const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt)
const busy = (status: number) => status === 429 || status === 503

/** Longest path first, so `/v1/keysets` never matches as `/v1/keys`. */
const OPERATIONS = Object.entries(NUTFT_OPERATIONS).sort(
  (a, b) => b[1].path.length - a[1].path.length
) as Array<[NutftOperation, (typeof NUTFT_OPERATIONS)[NutftOperation]]>

/**
 * Turn one request into a route, or refuse it. Exported for the tests, which
 * are the only place the mapping is asserted directly.
 */
export function routeRequest(
  input: string,
  method: string,
  options: Pick<CollectionTransportOptions, 'mint' | 'mirrors'>
): Route {
  const url = new URL(input)
  const mint = nutftMintUrl(options.mint)
  const verb = method.toUpperCase()

  if (input === mint || input.startsWith(mint + '/')) {
    const rest = input.slice(mint.length)
    const [pathname, query] = rest.split('?', 2)
    for (const [operation, spec] of OPERATIONS) {
      if (spec.method !== verb) continue
      if ('segment' in spec && spec.segment) {
        if (!pathname.startsWith(spec.path + '/')) continue
        const parameter = decodeURIComponent(
          pathname.slice(spec.path.length + 1)
        )
        if (parameter.includes('/')) break
        return {kind: 'operation', operation, parameter}
      }
      if (pathname !== spec.path) continue
      if (spec.method === 'POST') return {kind: 'operation', operation}
      const key = 'query' in spec ? spec.query : undefined
      if (!query) return {kind: 'operation', operation}
      const parameters = new URLSearchParams(query)
      /* The mint publishes exactly one query key per operation. A second one
         means the caller invented an argument the capability cannot carry. */
      const keys = [...parameters.keys()]
      if (!key || keys.length !== 1 || keys[0] !== key)
        throw new Error(`This mint operation takes no ${keys[0] ?? 'query'}.`)
      return {kind: 'operation', operation, parameter: parameters.get(key)!}
    }
    throw new Error(`The mint has no ${verb} operation for ${pathname}.`)
  }

  if (verb !== 'GET')
    throw new Error('Only the mint accepts anything but a byte fetch.')
  const origin = url.origin
  if (!options.mirrors.some(mirror => new URL(mirror).origin === origin))
    throw new Error('That address is not the mint or an approved mirror.')
  return {kind: 'mirror', url: input}
}

/**
 * A `fetch` for the collection napplet.
 *
 * Capability calls are serialised. The host permits one mint request per window
 * at a time, and the wallet asks for `/v1/info` and `/v1/keys` together, so
 * without this queue the second of the pair would be refused as a duplicate.
 *
 * A read that the mint answers with 429 or 503, or that the shell could not
 * deliver, is asked again: after the wait the mint named, or a backoff that
 * doubles from half a second, never more than twenty seconds at a time and at
 * most four times in all. The queue waits with it, since a rate limit is on
 * this client and not on one call. What still fails after that is handed to
 * the library as it came.
 */
export function createCollectionFetch(
  options: CollectionTransportOptions
): typeof fetch {
  const mint = nutftMintUrl(options.mint)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>(done => setTimeout(done, ms)))
  let queue: Promise<unknown> = Promise.resolve()
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
  }
  const tell = (operation: NutftOperation, detail?: {retryInMs: number}) => {
    try {
      if (detail) options.observe?.(operation, detail)
      else options.observe?.(operation)
    } catch {
      /* Progress is a courtesy; it never stops a mint call. */
    }
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const target =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    const method = init?.method ?? 'GET'
    const route = routeRequest(target, method, {mint, mirrors: options.mirrors})

    if (route.kind === 'mirror') {
      const blob = await options.resource.bytes(route.url, {
        signal: init?.signal ?? undefined
      })
      if (blob.size > maxBytes)
        throw new Error('That file is larger than this wallet accepts.')
      return new Response(blob, {status: 200})
    }

    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body === undefined || init?.body === null
          ? undefined
          : String(init.body)

    const request = {
      mint,
      operation: route.operation,
      ...(route.parameter !== undefined ? {parameter: route.parameter} : {}),
      ...(body !== undefined ? {body} : {})
    }
    const retries = READ_ONLY.has(route.operation)
    const reply = await serialised(async () => {
      for (let attempt = 0; ; attempt += 1) {
        if (attempt === 0) tell(route.operation)
        const last = attempt + 1 >= ATTEMPTS || !retries
        let wait: number
        try {
          const answer = await options.nutft.request(request)
          if (last || !busy(answer.status)) return answer
          wait = answer.retryAfterMs ?? backoff(attempt)
        } catch (error) {
          if (last) throw error
          wait = backoff(attempt)
        }
        const retryInMs = Math.max(0, Math.min(LONGEST_WAIT_MS, wait))
        tell(route.operation, {retryInMs})
        await sleep(retryInMs)
      }
    })
    return new Response(reply.body, {
      status: reply.status,
      headers: {'content-type': 'application/json'}
    })
  }
}

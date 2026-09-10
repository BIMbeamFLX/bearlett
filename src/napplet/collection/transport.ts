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
}

type Route =
  | {kind: 'operation'; operation: NutftOperation; parameter?: string}
  | {kind: 'mirror'; url: string}

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024

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
 */
export function createCollectionFetch(
  options: CollectionTransportOptions
): typeof fetch {
  const mint = nutftMintUrl(options.mint)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  let queue: Promise<unknown> = Promise.resolve()
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => {})
    return run
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

    const reply = await serialised(() =>
      options.nutft.request({
        mint,
        operation: route.operation,
        ...(route.parameter !== undefined ? {parameter: route.parameter} : {}),
        ...(body !== undefined ? {body} : {})
      })
    )
    return new Response(reply.body, {
      status: reply.status,
      headers: {'content-type': 'application/json'}
    })
  }
}

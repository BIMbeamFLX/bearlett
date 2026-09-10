import {NUTFT_OPERATIONS, nutftMintUrl} from './nutft-contract'
import type {NutftRequest, NutftResponse} from './nutft-contract'

export type NutftServiceOptions = {
  allowed(windowId: string, mint: string): boolean | Promise<boolean>
  scope(windowId: string): string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}
type Envelope = {type: string; id: string; request?: NutftRequest}

const PARAMETER = /^[a-zA-Z0-9_-]{1,200}$/
/** A card is one proof, and a deck is sixty. Nothing here needs thousands. */
const MAX_ITEMS = 256
const MAX_BODY_BYTES = 512_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/**
 * Map a validated operation onto a fixed mint endpoint. No arbitrary URL,
 * header or method crosses the boundary, and a body may only carry the fields
 * its own operation declares.
 */
export function nutftEndpoint(request: NutftRequest): {
  url: string
  method: string
} {
  if (
    !request ||
    typeof request !== 'object' ||
    !Object.hasOwn(NUTFT_OPERATIONS, request.operation)
  )
    throw new Error('Invalid operation.')
  const mint = nutftMintUrl(request.mint)
  const spec = NUTFT_OPERATIONS[request.operation]

  if (request.parameter !== undefined && !PARAMETER.test(request.parameter))
    throw new Error('Invalid operation parameter.')

  if (spec.method === 'GET') {
    const wantsParameter = 'segment' in spec || 'query' in spec
    if (!wantsParameter && request.parameter !== undefined)
      throw new Error('This operation takes no parameter.')
    if ('segment' in spec && !request.parameter)
      throw new Error('Invalid operation parameter.')
    if (request.body !== undefined) throw new Error('GET cannot carry a body.')
    const suffix =
      'segment' in spec && request.parameter
        ? '/' + encodeURIComponent(request.parameter)
        : ''
    const query =
      'query' in spec && spec.query && request.parameter
        ? '?' + spec.query + '=' + encodeURIComponent(request.parameter)
        : ''
    return {url: mint + spec.path + suffix + query, method: 'GET'}
  }

  if (request.parameter !== undefined)
    throw new Error('This operation takes no parameter.')
  if (
    typeof request.body !== 'string' ||
    new TextEncoder().encode(request.body).length > MAX_BODY_BYTES
  )
    throw new Error('Invalid request body.')
  let data: unknown
  try {
    data = JSON.parse(request.body)
  } catch {
    throw new Error('Invalid request body.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid request body.')
  const body = data as Record<string, unknown>
  /* Widened on purpose: each operation declares its own literal tuple, so the
     union of them narrows `includes` to `never`. */
  const fields: readonly string[] = spec.fields
  for (const key of Object.keys(body))
    if (!fields.includes(key)) throw new Error('Unsupported request field.')
  for (const name of ['inputs', 'outputs', 'Ys', 'authorizations'])
    if (
      name in body &&
      (!Array.isArray(body[name]) || body[name].length > MAX_ITEMS)
    )
      throw new Error('Request has too many items.')
  return {url: mint + spec.path, method: 'POST'}
}

/**
 * The reference NutFT service. Source-bound like the Cashu one: one writer per
 * storage scope, one request in flight per window, fixed endpoints, and errors
 * that never carry a bearer payload or the mint's address.
 */
export function createNutftService(options: NutftServiceOptions) {
  const scopes = new Map<string, string>()
  const inFlight = new Set<string>()

  const claim = (windowId: string) => {
    const scope = options.scope(windowId)
    if (!scope) throw new Error('Wallet session unavailable.')
    const owner = scopes.get(scope)
    if (owner && owner !== windowId)
      throw new Error('This collection is already open in another window.')
    scopes.set(scope, windowId)
  }

  const request = async (
    windowId: string,
    incoming: NutftRequest
  ): Promise<NutftResponse> => {
    claim(windowId)
    const {url, method} = nutftEndpoint(incoming)
    if (!(await options.allowed(windowId, nutftMintUrl(incoming.mint))))
      throw new Error('Mint access is not approved.')
    if (inFlight.has(windowId))
      throw new Error('A mint request is already running.')
    inFlight.add(windowId)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 30000
    )
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method,
        body: incoming.body,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})
        },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (!reader) throw new Error('Empty mint response.')
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('Mint response exceeds size limit.')
        }
        chunks.push(next.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      const retry = response.headers.get('Retry-After')
      return {
        status: response.status,
        body: new TextDecoder().decode(bytes),
        ...(retry && /^\d+$/.test(retry)
          ? {retryAfterMs: Math.min(Number(retry) * 1000, 3600000)}
          : {})
      }
    } finally {
      clearTimeout(timeout)
      inFlight.delete(windowId)
    }
  }

  return {
    descriptor: {
      name: 'nutft',
      version: '1.0.0',
      description: 'Bearlett NutFT mint transport (experimental extension)'
    },
    request,
    handleMessage(
      windowId: string,
      raw: unknown,
      send: (message: unknown) => void
    ): void {
      const msg = raw as Envelope
      if (
        !msg ||
        !['nutft.request', 'nutft.acquire'].includes(msg.type) ||
        typeof msg.id !== 'string' ||
        msg.id.length > 100
      )
        return
      void (async () => {
        try {
          claim(windowId)
          const result =
            msg.type === 'nutft.request'
              ? await request(windowId, msg.request!)
              : undefined
          send({type: msg.type + '.result', id: msg.id, ok: true, result})
        } catch (error) {
          send({
            type: msg.type + '.result',
            id: msg.id,
            ok: false,
            error:
              error instanceof Error &&
              error.message ===
                'This collection is already open in another window.'
                ? error.message
                : 'Mint request unavailable, denied, or interrupted. Check the stored operation before retrying.'
          })
        }
      })()
    },
    onWindowDestroyed(windowId: string): void {
      for (const [scope, owner] of scopes)
        if (owner === windowId) scopes.delete(scope)
    }
  }
}

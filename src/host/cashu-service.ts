import {CASHU_OPERATIONS, mintUrl} from './cashu-contract'
import type {CashuRequest, CashuResponse} from './cashu-contract'

export type CashuServiceOptions = {
  allowed(windowId: string, mint: string): boolean | Promise<boolean>
  scope(windowId: string): string | undefined
  fetch?: typeof fetch
  timeoutMs?: number
}
type Envelope = {type: string; id: string; request?: CashuRequest}

/** Map a validated operation to a fixed mint endpoint; no arbitrary URL or headers cross the boundary. */
export function cashuEndpoint(request: CashuRequest): {
  url: string
  method: string
} {
  if (
    !request ||
    typeof request !== 'object' ||
    !Object.hasOwn(CASHU_OPERATIONS, request.operation)
  )
    throw new Error('Invalid operation.')
  const mint = mintUrl(request.mint),
    [method, path] = CASHU_OPERATIONS[request.operation]
  const needsParameter = ['mintQuoteState', 'meltQuoteState'].includes(
    request.operation
  )
  if (
    (needsParameter && !request.parameter) ||
    (request.parameter !== undefined &&
      (!['keys', 'mintQuoteState', 'meltQuoteState'].includes(
        request.operation
      ) ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(request.parameter)))
  )
    throw new Error('Invalid operation parameter.')
  if (method === 'GET' && request.body !== undefined)
    throw new Error('GET cannot carry a body.')
  if (method === 'POST') {
    if (
      typeof request.body !== 'string' ||
      new TextEncoder().encode(request.body).length > 512000
    )
      throw new Error('Invalid request body.')
    const data = JSON.parse(request.body)
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid request body.')
    const fields: Record<string, string[]> = {
      mintQuote: ['amount', 'unit', 'description', 'pubkey'],
      mint: ['quote', 'outputs', 'signature'],
      meltQuote: ['request', 'unit'],
      melt: ['quote', 'inputs', 'outputs', 'prefer_async'],
      swap: ['inputs', 'outputs'],
      checkstate: ['Ys'],
      restore: ['outputs']
    }
    if (Object.keys(data).some(k => !fields[request.operation]?.includes(k)))
      throw new Error('Unsupported request field.')
    if ('unit' in data && data.unit !== 'sat')
      throw new Error('Only sat is supported.')
    for (const name of ['inputs', 'outputs', 'Ys'])
      if (
        name in data &&
        (!Array.isArray(data[name]) || data[name].length > 2048)
      )
        throw new Error('Request has too many items.')
  }
  return {
    url:
      mint +
      path +
      (request.parameter ? '/' + encodeURIComponent(request.parameter) : ''),
    method
  }
}

/** Kehto-compatible, source-bound service. Its errors and diagnostics never include bearer payloads. */
export function createCashuService(options: CashuServiceOptions) {
  const scopes = new Map<string, string>(),
    inFlight = new Set<string>()
  const claim = (windowId: string) => {
    const scope = options.scope(windowId)
    if (!scope) throw new Error('Wallet session unavailable.')
    const owner = scopes.get(scope)
    if (owner && owner !== windowId)
      throw new Error('This wallet is already open in another window.')
    scopes.set(scope, windowId)
  }
  const request = async (
    windowId: string,
    request: CashuRequest
  ): Promise<CashuResponse> => {
    claim(windowId)
    const {url, method} = cashuEndpoint(request)
    if (!(await options.allowed(windowId, mintUrl(request.mint))))
      throw new Error('Mint access is not approved.')
    if (inFlight.has(windowId))
      throw new Error('A mint request is already running.')
    inFlight.add(windowId)
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? (request.operation === 'melt' ? 300000 : 30000)
    )
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method,
        body: request.body,
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
      const reader = response.body?.getReader(),
        chunks: Uint8Array[] = []
      let size = 0
      if (!reader) throw new Error('Empty mint response.')
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 2 * 1024 * 1024) {
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
      name: 'cashu',
      version: '1.0.0',
      description: 'Bearlett Cashu mint transport (experimental extension)'
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
        !['cashu.request', 'cashu.acquire'].includes(msg.type) ||
        typeof msg.id !== 'string' ||
        msg.id.length > 100
      )
        return
      void (async () => {
        try {
          claim(windowId)
          const result =
            msg.type === 'cashu.request'
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
              error.message === 'This wallet is already open in another window.'
                ? error.message
                : 'Cashu request unavailable, denied, or interrupted. Check the stored operation before retrying.'
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

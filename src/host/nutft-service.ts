import {
  NUTFT_OPERATIONS,
  UNSAFE_OPEN_MESSAGE,
  UnsafeLease,
  isHostSeed,
  nutftMintUrl
} from './nutft-contract'
import type {NutftLease, NutftRequest, NutftResponse} from './nutft-contract'

export type NutftServiceOptions = {
  allowed(windowId: string, mint: string): boolean | Promise<boolean>
  scope(windowId: string): string | undefined
  /**
   * The collection wallet's seed for the account behind this window, when the
   * shell derives one: 32 bytes of BIP39 entropy as 64 lowercase hex, derived
   * for this `scope`, so each collection of an account gets a seed of its own.
   * `scope` is exactly what `scope(windowId)` returned, which must be the
   * string the host derives the seed from. Asked only for the window that
   * holds the lease, and the value goes nowhere but that window's acquire
   * result. `undefined` means the shell derives none. Anything else, a
   * rejection included, refuses the acquire.
   */
  seed?(
    windowId: string,
    scope: string
  ): string | undefined | Promise<string | undefined>
  fetch?: typeof fetch
  timeoutMs?: number
  /**
   * Where a lease is held across every tab of this shell's origin. Two tabs
   * each run a service of their own, and both write the same storage scope, so
   * a lease held only in this service would let each of them open the same
   * collection. Defaults to `navigator.locks` where the host has it; `null`
   * holds leases in this service alone, which leaves that guarantee to the
   * shell (docs/NAPPLETS.md).
   */
  locks?: Pick<LockManager, 'request'> | null
}
type Envelope = {type: string; id: string; request?: NutftRequest}

/** Web Lock names, one per storage scope. Not any shell's own lock name. */
export const NUTFT_LEASE_LOCK = 'bearlett:nutft-lease:'
const BUSY = 'This collection is already open in another window.'

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

/** Errors a napplet may read verbatim. Every other reason is redacted. */
const SAYABLE = new Set([BUSY, UNSAFE_OPEN_MESSAGE])

/**
 * The reference NutFT service. Source-bound like the Cashu one: one writer per
 * storage scope, one request in flight per window, fixed endpoints, and errors
 * that never carry a bearer payload, a seed or the mint's address.
 *
 * One writer per scope holds across tabs too: while a window holds a lease,
 * this service holds a Web Lock named for its scope, and a window in another
 * tab of the shell is told the collection is open elsewhere.
 */
export function createNutftService(options: NutftServiceOptions) {
  const scopes = new Map<string, string>()
  const inFlight = new Set<string>()
  const locks =
    options.locks === undefined
      ? ((globalThis as {navigator?: {locks?: Pick<LockManager, 'request'>}})
          .navigator?.locks ?? null)
      : options.locks
  /* Per scope: whether its lock was granted, and how to give it back. */
  const locking = new Map<string, Promise<boolean>>()
  const releases = new Map<string, () => void>()
  const released = new Map<string, Promise<unknown>>()

  const lockFor = (scope: string): Promise<boolean> => {
    const existing = locking.get(scope)
    if (existing) return existing
    const granted = (async () => {
      if (!locks) return true
      /* A lease given back a moment ago lets go of its lock first. */
      await released.get(scope)
      return new Promise<boolean>((resolve, reject) => {
        const held = locks
          .request(NUTFT_LEASE_LOCK + scope, {ifAvailable: true}, lock => {
            if (!lock) {
              resolve(false)
              return undefined
            }
            return new Promise<void>(release => {
              releases.set(scope, release)
              resolve(true)
            })
          })
          .catch(reject)
        released.set(scope, held)
      })
    })()
    locking.set(scope, granted)
    granted.then(
      ok => {
        if (!ok) locking.delete(scope)
      },
      () => locking.delete(scope)
    )
    return granted
  }

  /* A lock still being granted is left to arrive: a window that claims the
     scope meanwhile shares that grant, and a grant nobody claims any more is
     given back the moment it arrives, in claim(). */
  const unlock = (scope: string) => {
    const release = releases.get(scope)
    if (!release) return
    releases.delete(scope)
    locking.delete(scope)
    release()
  }

  const claim = async (windowId: string): Promise<void> => {
    const scope = options.scope(windowId)
    if (!scope) throw new Error('Wallet session unavailable.')
    const owner = scopes.get(scope)
    if (owner && owner !== windowId) throw new Error(BUSY)
    scopes.set(scope, windowId)
    let granted = false
    try {
      granted = await lockFor(scope)
    } finally {
      if (!granted && scopes.get(scope) === windowId) scopes.delete(scope)
    }
    if (!granted) throw new Error(BUSY)
    /* The window may have closed while the lock was asked for. */
    if (scopes.get(scope) !== windowId) {
      if (!scopes.has(scope)) unlock(scope)
      throw new Error('Wallet session unavailable.')
    }
  }

  /* The lease comes first, so a second window hears that the collection is
     busy and the seed hook is never asked on its behalf. A refused seed gives
     back a lease this acquire took, and the reason sent is one fixed sentence
     whatever the hook returned or threw: its value, and its error text, stay
     here. */
  const acquire = async (windowId: string): Promise<NutftLease | undefined> => {
    const scope = options.scope(windowId)
    const held = Boolean(scope) && scopes.get(scope!) === windowId
    await claim(windowId)
    if (!options.seed) return undefined
    try {
      const seed: unknown = await options.seed(windowId, scope!)
      if (seed !== undefined && !isHostSeed(seed)) throw new UnsafeLease()
      /* The window may have closed while the shell derived the seed. */
      if (scopes.get(scope!) !== windowId) throw new UnsafeLease()
      return isHostSeed(seed) ? {seed} : undefined
    } catch {
      if (!held && scopes.get(scope!) === windowId) {
        scopes.delete(scope!)
        unlock(scope!)
      }
      throw new UnsafeLease()
    }
  }

  const request = async (
    windowId: string,
    incoming: NutftRequest
  ): Promise<NutftResponse> => {
    await claim(windowId)
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
    acquire,
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
          const result =
            msg.type === 'nutft.request'
              ? await request(windowId, msg.request!)
              : await acquire(windowId)
          send({type: msg.type + '.result', id: msg.id, ok: true, result})
        } catch (error) {
          send({
            type: msg.type + '.result',
            id: msg.id,
            ok: false,
            error:
              error instanceof Error && SAYABLE.has(error.message)
                ? error.message
                : 'Mint request unavailable, denied, or interrupted. Check the stored operation before retrying.'
          })
        }
      })()
    },
    onWindowDestroyed(windowId: string): void {
      for (const [scope, owner] of scopes)
        if (owner === windowId) {
          scopes.delete(scope)
          unlock(scope)
        }
    }
  }
}

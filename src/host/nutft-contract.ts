/**
 * The NutFT mint transport, a sibling of the Cashu one.
 *
 * A collection napplet cannot reach its mint through either existing channel.
 * NAP-RESOURCE fetches bytes by URL, so it is GET only, and the `cashu`
 * capability carries a fixed map of the twelve standard Cashu endpoints, which
 * does not include the NutFT sales and trade paths. This contract adds exactly
 * those, under the same rule: a napplet names an operation, never a URL, and
 * anything not listed here cannot be reached.
 *
 * Card images are deliberately absent. They are ordinary byte fetches from
 * Blossom mirrors and belong on NAP-RESOURCE, not on a mint capability.
 */

type Get = {
  readonly method: 'GET'
  readonly path: string
  /** Carried as `?<query>=<parameter>`, the way the mint publishes it. */
  readonly query?: string
  /** Carried as a trailing path segment. */
  readonly segment?: true
}
type Post = {
  readonly method: 'POST'
  readonly path: string
  /** The only body fields this operation may carry. */
  readonly fields: readonly string[]
}

export const NUTFT_OPERATIONS = {
  info: {method: 'GET', path: '/v1/info'},
  keys: {method: 'GET', path: '/v1/keys'},
  keysets: {method: 'GET', path: '/v1/keysets'},
  catalog: {method: 'GET', path: '/nutft/catalog'},
  /** The signed catalogue by its own hash, served beside the mint. */
  blob: {method: 'GET', path: '/blossom', segment: true},
  state: {method: 'GET', path: '/nutft/state'},
  /** The signed, chained supply ledger; see `src/napplet/collection/supply.ts`. */
  supply: {method: 'GET', path: '/nutft/supply'},
  eligibility: {method: 'GET', path: '/nutft/eligibility'},
  quote: {method: 'GET', path: '/nutft/quote', query: 'deck'},
  reveal: {method: 'GET', path: '/nutft/reveal', query: 'payment_hash'},
  checkstate: {method: 'POST', path: '/v1/checkstate', fields: ['Ys']},
  restore: {method: 'POST', path: '/v1/restore', fields: ['outputs']},
  purchase: {
    method: 'POST',
    path: '/nutft/purchase',
    fields: ['purchase_id', 'pack_id', 'state', 'payment_hash', 'deck_id']
  },
  booster: {
    method: 'POST',
    path: '/nutft/booster',
    fields: [
      'idempotency_key',
      'purchase_id',
      'pack_id',
      'state',
      'payment_hash',
      'deck_id',
      'outputs'
    ]
  },
  trade: {
    method: 'POST',
    path: '/nutft/trade',
    fields: ['idempotency_key', 'inputs', 'outputs']
  },
  possession: {
    method: 'POST',
    path: '/nutft/possession',
    fields: ['player', 'room', 'inputs', 'authorizations']
  }
} as const satisfies Record<string, Get | Post>

export type NutftOperation = keyof typeof NUTFT_OPERATIONS

export type NutftRequest = {
  mint: string
  operation: NutftOperation
  /** A blob hash, a payment hash, or a keyset id. Never a URL. */
  parameter?: string
  /** Exact JSON bytes for a POST. */
  body?: string
}

export type NutftResponse = {
  status: number
  body: string
  retryAfterMs?: number
}

export type NutftHost = {
  acquire?(): Promise<void>
  request(request: NutftRequest): Promise<NutftResponse>
}

/**
 * Canonical mint identity, including its path: the G edition lives under `/g`
 * on the same origin as Edition One, and the two are different mints. Query,
 * fragment and credentials are refused so a token can never point the napplet
 * at a mint that carries its own arguments.
 */
export function nutftMintUrl(input: string): string {
  const url = new URL(input)
  const loopback =
    url.protocol === 'http:' &&
    ['127.0.0.1', '0.0.0.0', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTPS mint URL without credentials, query or fragment.'
    )
  return url.href.replace(/\/+$/, '')
}

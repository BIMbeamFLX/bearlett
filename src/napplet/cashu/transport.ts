import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  RateLimitError
} from '@cashu/cashu-ts'
import type {RequestFn} from '@cashu/cashu-ts'
import {decodeBolt11AmountMsat} from '../../lnurlcash'

export {CASHU_OPERATIONS, mintUrl} from '../../host/cashu-contract'
export type {
  CashuOperation,
  CashuRequest,
  CashuResponse,
  CashuHost
} from '../../host/cashu-contract'
import {CASHU_OPERATIONS, mintUrl} from '../../host/cashu-contract'
import type {CashuOperation, CashuHost} from '../../host/cashu-contract'

/** Restrict the Cashu library to the documented, mint-scoped host operations. */
export function cashuRequest(
  host: CashuHost,
  mint: string,
  offline: () => boolean,
  quotes: Record<
    string,
    {invoice?: string; quote?: Record<string, unknown>}
  > = {}
): RequestFn {
  const base = mintUrl(mint)
  return async options => {
    if (offline()) throw new NetworkError('Wallet is offline.')
    const endpoint = new URL(options.endpoint)
    if (
      !endpoint.href.startsWith(base + '/v1/') ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('Cashu request escaped its mint.')
    const path = endpoint.pathname.slice(
      new URL(base).pathname.replace(/\/+$/, '').length
    )
    const method = (options.method ?? 'GET').toUpperCase()
    const entry = Object.entries(CASHU_OPERATIONS).find(
      ([name, [verb, route]]) =>
        verb === method &&
        (path === route ||
          (['keys', 'mintQuoteState', 'meltQuoteState'].includes(name) &&
            path.startsWith(route + '/')))
    )
    if (!entry) throw new Error('Unsupported Cashu endpoint.')
    const [operation, [, route]] = entry
    const body =
      options.requestBody === undefined
        ? undefined
        : typeof options.requestBody === 'string'
          ? options.requestBody
          : JSON.stringify(options.requestBody)
    const response = await host.request({
      mint: base,
      operation: operation as CashuOperation,
      parameter:
        path === route
          ? undefined
          : decodeURIComponent(path.slice(route.length + 1)),
      body
    })
    if (response.status === 429)
      throw new RateLimitError('Mint is rate limited.', response.retryAfterMs)
    let value: unknown
    try {
      value = JSON.parse(response.body)
    } catch {
      throw new HttpResponseError('Invalid mint JSON.', response.status)
    }
    if (response.status < 200 || response.status >= 300) {
      const error = value as {code?: number; detail?: string}
      if (
        response.status === 400 &&
        Number.isInteger(error?.code) &&
        typeof error.detail === 'string'
      )
        throw new MintOperationError(error.code!, error.detail)
      throw new HttpResponseError('Mint request failed.', response.status)
    }
    // Older NUT-04/05 responses omit fields required by cashu-ts 4.10.
    // Fill only from this wallet's bound request/journal, never from an unrelated quote.
    if (
      [
        'mintQuote',
        'mintQuoteState',
        'meltQuote',
        'meltQuoteState',
        'melt'
      ].includes(operation)
    ) {
      const data = value as Record<string, unknown>,
        sent = JSON.parse(body ?? '{}')
      const known =
        quotes[
          String(
            sent.quote ??
              (path === route
                ? ''
                : decodeURIComponent(path.slice(route.length + 1)))
          )
        ]
      const invoice =
        typeof data.request === 'string'
          ? data.request
          : (sent.request ?? known?.invoice)
      data.unit ??= 'sat'
      if (operation.startsWith('mint'))
        data.amount ??=
          sent.amount ??
          (invoice ? decodeBolt11AmountMsat(invoice)! / 1000 : undefined)
      else {
        data.request ??= invoice
        data.amount ??= known?.quote?.amount
        data.fee_reserve ??= known?.quote?.fee_reserve
      }
      if (data.unit !== 'sat') throw new Error('Mint changed the quote unit.')
    }
    return value as never
  }
}

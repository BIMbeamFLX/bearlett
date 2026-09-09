export const CASHU_OPERATIONS = {
  info: ['GET', '/v1/info'],
  keysets: ['GET', '/v1/keysets'],
  keys: ['GET', '/v1/keys'],
  mintQuote: ['POST', '/v1/mint/quote/bolt11'],
  mintQuoteState: ['GET', '/v1/mint/quote/bolt11'],
  mint: ['POST', '/v1/mint/bolt11'],
  swap: ['POST', '/v1/swap'],
  meltQuote: ['POST', '/v1/melt/quote/bolt11'],
  meltQuoteState: ['GET', '/v1/melt/quote/bolt11'],
  melt: ['POST', '/v1/melt/bolt11'],
  checkstate: ['POST', '/v1/checkstate'],
  restore: ['POST', '/v1/restore']
} as const
export type CashuOperation = keyof typeof CASHU_OPERATIONS
export type CashuRequest = {
  mint: string
  operation: CashuOperation
  parameter?: string
  body?: string
}
export type CashuResponse = {
  status: number
  body: string
  retryAfterMs?: number
}
export type CashuHost = {
  acquire?(): Promise<void>
  request(request: CashuRequest): Promise<CashuResponse>
}

/** Canonical mint identity includes its path; never follow a token's credentials or fragment. */
export function mintUrl(input: string): string {
  const url = new URL(input)
  if (
    url.protocol !== 'https:' ||
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

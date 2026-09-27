// LUD-06 payRequests, as LUD-25 uses them: minting (withdrawLink, a comment
// naming the note), the mint fee, and the text/cpub hint for internal
// transfers. LUD-21 verify for settlement.
import {decodeCx1, type BranchExport} from '../spec/encoding.ts'
import {ServiceError, TransportError} from './errors.ts'
import {fromLud17, invoiceAmountMsat} from './links.ts'
import {requireServiceUrl, type Net} from './net.ts'

export type MintFee = {baseMsat: number; ppm: number}

export type PayRequest = {
  url: string
  callback: string
  minSendable: number
  maxSendable: number
  metadata: string
  commentAllowed: number
  /** LUD-25 Minting: paying this payRequest mints a note there */
  withdrawLink?: string
  identifier?: string
  description?: string
  mintFee?: MintFee
  /** LUD-25 Internal transfer: the payee's branch and next-index hint */
  cpub?: {branch: BranchExport; index: number}
}

type MetadataEntry = [string, string]

const parseMetadata = (metadata: string): MetadataEntry[] => {
  try {
    const entries = JSON.parse(metadata)
    if (!Array.isArray(entries)) return []
    return entries.filter(
      (entry): entry is MetadataEntry =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string'
    )
  } catch {
    return []
  }
}

/** `Mint fees: <base_fee_msat>,<fee_percent_ppm>` in a text/plain entry. */
const parseMintFee = (entries: MetadataEntry[]): MintFee | undefined => {
  for (const [type, value] of entries) {
    const match = /^Mint fees: (\d+),(\d+)$/.exec(value.trim())
    if (type === 'text/plain' && match)
      return {baseMsat: Number(match[1]), ppm: Number(match[2])}
  }
  return undefined
}

/** `["text/cpub", "cx1<...>:<i>"]` */
const parseCpub = (entries: MetadataEntry[]): PayRequest['cpub'] => {
  for (const [type, value] of entries) {
    if (type !== 'text/cpub') continue
    const at = value.lastIndexOf(':')
    const branch = decodeCx1(value.slice(0, at))
    const index = Number(value.slice(at + 1))
    if (branch && Number.isSafeInteger(index) && index >= 0)
      return {branch, index}
  }
  return undefined
}

/** The value a mint payment of `amountMsat` should credit (Minting). */
export const expectedMintValue = (amountMsat: number, fee?: MintFee): number =>
  fee
    ? amountMsat - fee.baseMsat - Math.floor((amountMsat * fee.ppm) / 1_000_000)
    : amountMsat

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN

export const parsePayRequest = (
  url: string,
  body: Record<string, unknown>
): PayRequest => {
  if (body.tag !== 'payRequest' || typeof body.callback !== 'string')
    throw new TransportError('This link is not a payRequest.')
  requireServiceUrl(body.callback)
  const metadata = typeof body.metadata === 'string' ? body.metadata : '[]'
  const entries = parseMetadata(metadata)
  // LUD-17 lets it arrive as lnurlw://
  const withdrawLink =
    typeof body.withdrawLink === 'string'
      ? fromLud17(body.withdrawLink)
      : undefined
  if (withdrawLink) requireServiceUrl(withdrawLink)
  return {
    url,
    callback: body.callback,
    minSendable: number(body.minSendable),
    maxSendable: number(body.maxSendable),
    metadata,
    commentAllowed: Number.isSafeInteger(body.commentAllowed)
      ? (body.commentAllowed as number)
      : 0,
    withdrawLink,
    identifier: entries.find(([type]) => type === 'text/identifier')?.[1],
    description: entries.find(([type]) => type === 'text/plain')?.[1],
    mintFee: parseMintFee(entries),
    cpub: parseCpub(entries)
  }
}

export const fetchPayRequest = async (
  net: Net,
  url: string,
  signal?: AbortSignal
): Promise<PayRequest> => parsePayRequest(url, await net.get(url, {signal}))

/** Whether minting here is possible: LUD-25 needs a withdrawLink and 64. */
export const canMint = (pay: PayRequest): boolean =>
  Boolean(pay.withdrawLink) && pay.commentAllowed >= 64

export type Invoice = {pr: string; verify?: string}

/** LUD-06 step 5, with the invoice amount checked against the request. */
export const requestInvoice = async (
  net: Net,
  pay: PayRequest,
  amountMsat: number,
  comment?: string,
  signal?: AbortSignal
): Promise<Invoice> => {
  if (amountMsat < pay.minSendable || amountMsat > pay.maxSendable)
    throw new ServiceError(
      `The amount must be between ${pay.minSendable} and ${pay.maxSendable} msat.`
    )
  if (comment && comment.length > pay.commentAllowed)
    throw new ServiceError('The comment is longer than this service accepts.')
  const url = new URL(pay.callback)
  url.searchParams.set('amount', String(amountMsat))
  if (comment) url.searchParams.set('comment', comment)
  const body = await net.get(url.toString(), {signal})
  if (typeof body.pr !== 'string')
    throw new TransportError('The service answered without an invoice.')
  if (invoiceAmountMsat(body.pr) !== amountMsat)
    throw new TransportError('The invoice is not for the amount requested.')
  const verify = typeof body.verify === 'string' ? body.verify : undefined
  if (verify) requireServiceUrl(verify)
  return {pr: body.pr, verify}
}

/** LUD-21: whether the invoice behind `verify` has settled. */
export const fetchSettlement = async (
  net: Net,
  verify: string,
  signal?: AbortSignal
): Promise<{settled: boolean; preimage?: string}> => {
  const body = await net.get(verify, {signal})
  return {
    settled: body.settled === true,
    preimage: typeof body.preimage === 'string' ? body.preimage : undefined
  }
}

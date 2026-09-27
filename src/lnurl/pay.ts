// LUD-06 payRequests, as LUD-25 uses them: minting (withdrawLink, a comment
// naming the note), the mint fee, and the text/cpub hint for internal
// transfers. LUD-21 verify for settlement.
import {decodeCx1, type BranchExport} from '../spec/encoding.ts'
import {ProtocolError, ServiceError} from './errors.ts'
import {fromLud17, invoiceAmountMsat, isInvoice} from './links.ts'
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

const FEE_ENTRY = /^Mint fees:\s*(\d+)\s*,\s*(\d+)\s*$/

/**
 * `Mint fees: <base_fee_msat>,<fee_percent_ppm>` in a text/plain entry; the
 * first valid one wins. A zero fee reads as none, and a fee of 100% or more
 * (which can never net anything) or past 2^53 is not a valid entry.
 */
export const parseMintFee = (metadata: string): MintFee | undefined => {
  for (const [type, value] of parseMetadata(metadata)) {
    const match = type === 'text/plain' ? FEE_ENTRY.exec(value.trim()) : null
    if (!match) continue
    const baseMsat = Number(match[1])
    const ppm = Number(match[2])
    if (!Number.isSafeInteger(baseMsat) || !Number.isSafeInteger(ppm)) continue
    if (ppm >= 1_000_000) continue
    return baseMsat === 0 && ppm === 0 ? undefined : {baseMsat, ppm}
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

/**
 * The value a mint payment of `amountMsat` should credit (Minting):
 * gross - base - floor(gross * ppm / 1e6), never below 0. The proportional
 * part is split so it stays exact past 2^53 msat · ppm.
 */
export const expectedMintValue = (
  amountMsat: number,
  fee?: MintFee
): number => {
  if (!fee) return amountMsat
  const proportional =
    Math.floor(amountMsat / 1_000_000) * fee.ppm +
    Math.floor(((amountMsat % 1_000_000) * fee.ppm) / 1_000_000)
  return Math.max(0, amountMsat - fee.baseMsat - proportional)
}

/**
 * The smallest payment that nets `netMsat` after the fee: apply is
 * non-decreasing, so a binary search finds the exact minimum even at a
 * near-100% fee, where walking up from an estimate would not end.
 */
export const grossForNet = (netMsat: number, fee?: MintFee): number => {
  if (!fee || netMsat <= 0) return Math.max(0, netMsat)
  let low = netMsat
  let high = netMsat + fee.baseMsat
  while (expectedMintValue(high, fee) < netMsat) high *= 2
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (expectedMintValue(middle, fee) >= netMsat) high = middle
    else low = middle + 1
  }
  return low
}

const number = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : NaN

export const parsePayRequest = (
  url: string,
  body: Record<string, unknown>
): PayRequest => {
  if (body.tag !== 'payRequest' || typeof body.callback !== 'string')
    throw new ProtocolError('This link is not a payRequest.')
  requireServiceUrl(body.callback)
  const metadata = typeof body.metadata === 'string' ? body.metadata : '[]'
  const entries = parseMetadata(metadata)
  // LUD-17 lets it arrive as lnurlw://
  const withdrawLink =
    typeof body.withdrawLink === 'string'
      ? fromLud17(body.withdrawLink)
      : undefined
  if (withdrawLink) requireServiceUrl(withdrawLink)
  const commentAllowed = Number.isSafeInteger(body.commentAllowed)
    ? (body.commentAllowed as number)
    : 0
  // Minting: a payLink advertising withdrawLink MUST allow 64 characters
  if (withdrawLink && commentAllowed < 64)
    throw new ProtocolError(
      'This mint cannot take the note it would mint (commentAllowed below 64).'
    )
  return {
    url,
    callback: body.callback,
    minSendable: number(body.minSendable),
    maxSendable: number(body.maxSendable),
    metadata,
    commentAllowed,
    withdrawLink,
    identifier: entries.find(([type]) => type === 'text/identifier')?.[1],
    description: entries.find(([type]) => type === 'text/plain')?.[1],
    mintFee: parseMintFee(metadata),
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
  if (typeof body.pr !== 'string' || !isInvoice(body.pr))
    throw new ProtocolError('The service answered without an invoice.')
  // an amountless invoice passes: nothing to check it against, and the
  // SERVICE that issued it judges what it is paid
  const invoiced = invoiceAmountMsat(body.pr)
  if (invoiced !== null && invoiced !== amountMsat)
    throw new ProtocolError('The invoice is not for the amount requested.')
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
  return parseSettlement(await net.get(verify, {signal}))
}

/** A LUD-21 answer binds its result to an invoice, and says settled as a boolean. */
export const parseSettlement = (
  body: Record<string, unknown>
): {settled: boolean; preimage?: string} => {
  if (typeof body.settled !== 'boolean' || typeof body.pr !== 'string')
    throw new ProtocolError(
      'The verify answer does not say whether it settled.'
    )
  return {
    settled: body.settled,
    preimage: typeof body.preimage === 'string' ? body.preimage : undefined
  }
}

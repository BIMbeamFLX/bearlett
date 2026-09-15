import type {
  Token,
  getDecodedTokenBinary,
  getEncodedTokenBinary
} from '@cashu/cashu-ts'

/**
 * Card tokens, read and written without the mint.
 *
 * cashu-ts reads a `cashuB` token only when it is given the mint's full keyset
 * ids, because a version 2 id travels in its short form. The collection often
 * has to look inside a token before it may ask the mint anything: to spell its
 * mint the way this collection does, or to merge restored cards into a wallet.
 * The binary form cashu-ts also reads keeps each proof's id exactly as it was
 * written, short or full, so a token can be taken apart and put back together
 * offline, and the card library maps the ids when it reads it later.
 *
 * Tokens are written the way the card library writes them: the binary form,
 * without its five-byte `crawB` prefix, in unpadded base64url behind `cashuB`.
 */

export type CardProof = {
  id: string
  amount: unknown
  secret: string
  C: string
  p2pk_e?: string
  dleq?: unknown
  witness?: unknown
}

export type Cards = {mint: string; unit: string; proofs: CardProof[]}

/** The two cashu-ts functions this module needs. */
export type TokenCodec = {
  getDecodedTokenBinary: typeof getDecodedTokenBinary
  getEncodedTokenBinary: typeof getEncodedTokenBinary
}

const PREFIX = new TextEncoder().encode('crawB')

const fromBase64Url = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_+/=-]*$/.test(text)) throw new Error('not base64')
  const plain = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const binary = atob(plain + '='.repeat((4 - (plain.length % 4)) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A `cashuA` or `cashuB` token taken apart, proof ids as written. */
export function decodeCards(token: string, codec: TokenCodec): Cards {
  if (token.startsWith('cashuB')) {
    const body = fromBase64Url(token.slice('cashuB'.length))
    const bytes = new Uint8Array(PREFIX.length + body.length)
    bytes.set(PREFIX)
    bytes.set(body, PREFIX.length)
    const read = codec.getDecodedTokenBinary(bytes)
    return {
      mint: read.mint,
      unit: read.unit ?? 'sat',
      proofs: read.proofs as unknown as CardProof[]
    }
  }
  if (token.startsWith('cashuA')) {
    const read = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token.slice('cashuA'.length)))
    )
    const entries = read?.token
    if (!Array.isArray(entries) || entries.length !== 1)
      throw new Error('one mint per token')
    return {
      mint: String(entries[0].mint),
      unit: typeof read.unit === 'string' ? read.unit : 'sat',
      proofs: [...entries[0].proofs]
    }
  }
  throw new Error('not a cashu token')
}

/** Cards written as a `cashuB` token, the way the card library writes them. */
export const encodeCards = (cards: Cards, codec: TokenCodec): string =>
  `cashuB${toBase64Url(
    codec.getEncodedTokenBinary(cards as unknown as Token).slice(PREFIX.length)
  )}`

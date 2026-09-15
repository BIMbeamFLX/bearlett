import {nutftMintUrl} from '../../host/nutft-contract'
import type {CollectionEdition} from './bootstrap'
import type {TokenTools} from './session'
import {decodeCards, encodeCards} from './tokens'
import type {TokenCodec} from './tokens'

/**
 * Taking a card in.
 *
 * A card arrives as a Cashu token, pasted by the holder or handed over by
 * another napplet on `napplet:collection/receive`, where it waits for the
 * holder like a pasted one. Everything that can be
 * decided without the mint is decided here first: that it is a token at all,
 * that it names this edition's mint exactly, that it is a card, and that it is
 * locked to this wallet's key. A token that fails any of that never reaches a
 * mint, and one locked to someone else is answered with where to send it
 * instead.
 *
 * A token is a card. It is never logged, never put in a URL, and never repeated
 * in an error: every refusal below is a fixed sentence.
 */

export const RECEIVE_CONVENTION = 'napplet:collection/receive'

/** A sixty-card deck is a few dozen kilobytes; nothing needs more. */
export const MAX_TOKEN_LENGTH = 256_000

/** Cards other napplets handed over that wait their turn, at most. */
export const MAX_WAITING_DELIVERIES = 16

/**
 * Where to get a card bought on the website into the collection. Said in the
 * paste help, word for word as in docs/NAPPLETS.md.
 */
export const WEBSITE_CARDS =
  "A card bought on tcg.nappelin.com is locked to that site's wallet: send it to your collection's address in the wallet there first, then paste the token into the collection."

const SAID = {
  empty: 'Paste a card token first.',
  'not-a-token':
    'This is not a card token. A card token starts with cashuA or cashuB.',
  'other-mint': 'This card belongs to a different mint.',
  'other-collection': 'This card belongs to a different collection.',
  'not-a-card': 'This token does not hold cards from this collection.',
  locked:
    "This card is locked to another address. Ask the sender to hand it over to this collection's address, shown above.",
  'already-held': 'This card is already in your collection.',
  spent: 'This card was already redeemed, so the mint will not take it again.',
  'unknown-card': 'The mint does not recognise this card.',
  unreachable:
    'The mint could not be reached, so nothing was redeemed. Try again.',
  waiting:
    'A card is already waiting here to be redeemed. Redeem or clear it first.',
  moving:
    'Cards on this device are still being moved to an account, so nothing can be received here until that move has finished.',
  failed: 'The card could not be redeemed. Try again.'
} as const

export type ReceiveReason = keyof typeof SAID

export class ReceiveProblem extends Error {
  constructor(readonly reason: ReceiveReason) {
    super(SAID[reason])
    this.name = 'ReceiveProblem'
  }
}

/* Refusals no second try can change. */
const FINAL: ReadonlySet<ReceiveReason> = new Set([
  'empty',
  'not-a-token',
  'other-mint',
  'other-collection',
  'not-a-card',
  'locked',
  'already-held',
  'spent'
])

/**
 * Whether a refusal is the last word on a token. Only then, or once the card
 * is in, does the token leave the field: after any other refusal the same
 * token may go through on the next try, and it is the card.
 */
export const isFinalRefusal = (problem: ReceiveProblem): boolean =>
  FINAL.has(problem.reason)

/**
 * A card another napplet handed over joins the line of cards waiting for the
 * holder, once. The one already in the field and the ones in line are not
 * added twice, and a full line takes no more.
 */
export function queueDelivery(
  waiting: readonly string[],
  token: string,
  inField: string
): readonly string[] {
  if (
    token === inField.trim() ||
    waiting.includes(token) ||
    waiting.length >= MAX_WAITING_DELIVERIES
  )
    return waiting
  return [...waiting, token]
}

/** A token read without the mint, with the proofs a lock check needs. */
export type CardToken = {
  token: string
  proofs: ReadonlyArray<{secret: string; p2pk_e: string}>
}

/**
 * Read a pasted or delivered token, offline.
 *
 * A token's mint is this edition's mint when both name the same mint, the way
 * `nutftMintUrl` spells it: a trailing slash does not make another mint. The
 * card library compares the two strings exactly when it imports, so a token
 * that spells the mint differently is written out again under this edition's
 * spelling, its proofs untouched. Any other mint is refused here.
 */
export function readCardToken(
  input: unknown,
  edition: Pick<CollectionEdition, 'mint' | 'units'>,
  tools: Pick<TokenTools, 'getTokenMetadata'> & TokenCodec
): CardToken {
  if (typeof input !== 'string' || input.length > MAX_TOKEN_LENGTH)
    throw new ReceiveProblem('not-a-token')
  const text = input.trim()
  if (!text) throw new ReceiveProblem('empty')
  let token = text.startsWith('cashu:') ? text.slice('cashu:'.length) : text
  if (!/^cashu[AB][A-Za-z0-9_+/=-]+$/.test(token))
    throw new ReceiveProblem('not-a-token')
  let read: ReturnType<TokenTools['getTokenMetadata']>
  try {
    read = tools.getTokenMetadata(token)
  } catch {
    throw new ReceiveProblem('not-a-token')
  }
  let mint = ''
  try {
    mint = nutftMintUrl(read.mint)
  } catch {
    throw new ReceiveProblem('other-mint')
  }
  if (mint !== edition.mint) throw new ReceiveProblem('other-mint')
  if (edition.units.length && !edition.units.includes(read.unit))
    throw new ReceiveProblem('other-collection')
  const proofs = read.incompleteProofs
  if (
    !Array.isArray(proofs) ||
    !proofs.length ||
    proofs.some(
      proof =>
        typeof proof?.secret !== 'string' ||
        String(proof.amount) !== '1' ||
        typeof proof.p2pk_e !== 'string'
    )
  )
    throw new ReceiveProblem('not-a-card')
  if (read.mint !== edition.mint)
    try {
      token = encodeCards(
        {...decodeCards(token, tools), mint: edition.mint},
        tools
      )
    } catch {
      throw new ReceiveProblem('not-a-token')
    }
  return {
    token,
    proofs: proofs.map(({secret, p2pk_e}) => ({secret, p2pk_e: p2pk_e!}))
  }
}

/** Refuse a card locked to any key but this wallet's, before the mint. */
export function checkLockedTo(
  card: CardToken,
  privateKey: string,
  tools: Pick<TokenTools, 'maybeDeriveP2BKPrivateKeys'>
): void {
  let ours: boolean
  try {
    ours = card.proofs.every(
      proof => tools.maybeDeriveP2BKPrivateKeys(privateKey, proof).length > 0
    )
  } catch {
    throw new ReceiveProblem('not-a-card')
  }
  if (!ours) throw new ReceiveProblem('locked')
}

/**
 * What the card library's refusal means to a holder. The library's own words
 * are matched, never shown: a decoding error can quote the bytes it choked on.
 */
export function receiveProblem(error: unknown): ReceiveProblem {
  if (error instanceof ReceiveProblem) return error
  /* Read as a property: the card library may run in another realm, where its
     errors are not instances of this realm's Error. */
  const message = (error as {message?: unknown} | null)?.message
  const said = typeof message === 'string' ? message : ''
  if (/token is already in this wallet/.test(said))
    return new ReceiveProblem('already-held')
  /* Only reached after the lock check, so here it means spent. */
  if (/token is spent or not addressed to this wallet/.test(said))
    return new ReceiveProblem('spent')
  if (/token mint, unit, or proofs are invalid/.test(said))
    return new ReceiveProblem('other-mint')
  if (
    /invalid NutFT proof|no verified asset|duplicate proof|catalog/.test(said)
  )
    return new ReceiveProblem('unknown-card')
  if (
    /unavailable|timed out|interrupted|non-JSON|invalid error response|denied/i.test(
      said
    )
  )
    return new ReceiveProblem('unreachable')
  return new ReceiveProblem('failed')
}

/** The token another napplet delivered on the receive intent, unchecked. */
export function receiveIntentToken(payload: unknown): string {
  const token =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as {token?: unknown}).token
      : undefined
  if (typeof token !== 'string') throw new ReceiveProblem('not-a-token')
  return token
}

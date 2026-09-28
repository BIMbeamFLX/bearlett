// The holder's side of LNURLcash cards (docs/CARDS-LNURLCASH.md): making a
// move, and asking a card mint about its cards over LNURL.
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, equalBytes, hexToBytes} from '../spec/bytes.ts'
import {encodeCp1, isPointX} from '../spec/encoding.ts'
import {leafSpend, signLeaf} from '../spec/notes.ts'
import {spendDomain, type TimeClaim} from '../spec/spend.ts'
import {ProtocolError} from '../lnurl/errors.ts'
import {
  isAllowedServiceUrl,
  plainHttpHost,
  requireServiceUrl,
  type Net
} from '../lnurl/net.ts'
import {fetchNoteInfo} from '../lnurl/withdraw.ts'
import {moveDigest, verifyConsignment, type Card} from './proofs.ts'
import {cardNote, encodeState, nextState, type CardState} from './state.ts'

/** The time claim dni's seals.ts signs a move with: none. */
export const MOVE_CLAIM: TimeClaim = {locktime: 0, sequence: 0xfffffffe}

export type Move = {
  /** the cw1 that opens the current state */
  k1: string
  /** cp1 of the note the next state locks to */
  p1: string
  /** the next state, hex */
  state: string
  next: CardState
}

/** Opens the card at `head` with its owner's key and names the next owner. */
export const makeMove = (
  head: CardState,
  ownerKey: Uint8Array,
  to: Uint8Array,
  domain: string
): Move => {
  const note = cardNote(head)
  const sig = signLeaf(note, ownerKey, domain, MOVE_CLAIM)
  const next = nextState(head, to)
  return {
    k1: leafSpend(note, [sig, encodeState(head)], MOVE_CLAIM),
    p1: encodeCp1(cardNote(next).q),
    state: bytesToHex(encodeState(next)),
    next
  }
}

export type Pack = {
  /** the LUD-06 payRequest that sells it */
  lnurlp: string
  edition: string
  collection_id: string
  catalog_uri: string
}

export type CardMintInfo = {
  issuer: Uint8Array
  withdraw: string
  lookup: string
  packs: Pack[]
}

/** Where a card mint describes itself: `tcg.example` or any URL on it. */
export const discoveryUrl = (input: string): string | null => {
  const text = input.trim()
  if (!text) return null
  try {
    const bare = /^[a-z]+:\/\//i.test(text) ? new URL(text) : null
    const host = bare ? bare.host : new URL(`https://${text}`).host
    const scheme = plainHttpHost(new URL(`https://${host}`).hostname)
      ? 'http'
      : 'https'
    return `${scheme}://${host}/.well-known/lnurlcash-cards`
  } catch {
    return null
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const parsePack = (value: unknown): Pack => {
  const pack = value as Record<string, unknown>
  if (typeof pack !== 'object' || pack === null)
    throw new ProtocolError('A pack the card mint names is not one.')
  const {lnurlp, edition, collection_id, catalog_uri} = pack
  if (typeof lnurlp !== 'string')
    throw new ProtocolError('A pack has no payRequest.')
  requireServiceUrl(lnurlp)
  if (typeof edition !== 'string' || !NAME.test(edition))
    throw new ProtocolError('A pack names no edition.')
  if (typeof collection_id !== 'string' || !NAME.test(collection_id))
    throw new ProtocolError('A pack names no collection.')
  // any address a service may have; only the Hangar's inventory insists on https
  if (
    typeof catalog_uri !== 'string' ||
    (catalog_uri !== '' && !isAllowedServiceUrl(catalog_uri))
  )
    throw new ProtocolError('A pack names no catalog it could have.')
  return {lnurlp, edition, collection_id, catalog_uri}
}

/** A card mint's discovery document, read strictly. */
export const parseCardMint = (body: Record<string, unknown>): CardMintInfo => {
  if (body.v !== 0) throw new ProtocolError('Not a card mint, or a newer one.')
  const issuer =
    typeof body.issuer === 'string' && /^[0-9a-f]{64}$/.test(body.issuer)
      ? hexToBytes(body.issuer)
      : null
  if (!issuer || !isPointX(issuer))
    throw new ProtocolError('The card mint names no issuer key.')
  if (typeof body.withdraw !== 'string' || typeof body.lookup !== 'string')
    throw new ProtocolError('The card mint names no endpoints.')
  const withdraw = requireServiceUrl(body.withdraw)
  const lookup = requireServiceUrl(body.lookup)
  if (lookup.origin !== withdraw.origin)
    throw new ProtocolError('The card mint’s endpoints are on two origins.')
  if (!Array.isArray(body.packs))
    throw new ProtocolError('The card mint lists no packs.')
  return {
    issuer,
    withdraw: withdraw.toString(),
    lookup: lookup.toString(),
    packs: body.packs.map(parsePack)
  }
}

export const fetchCardMint = async (
  net: Net,
  url: string
): Promise<CardMintInfo> => parseCardMint(await net.get(url))

/**
 * The live cards an owner key holds, each checked in full against the
 * issuer; a card mint that sends anything else is not trusted at all.
 */
export const fetchCardsOf = async (
  net: Net,
  mint: CardMintInfo,
  owner: Uint8Array
): Promise<Card[]> => {
  const url = requireServiceUrl(mint.lookup)
  url.searchParams.set('owner', bytesToHex(owner))
  const body = await net.get(url.toString())
  if (!Array.isArray(body.cards))
    throw new ProtocolError('The card mint answered without cards.')
  return body.cards.map(value => {
    const card = verifyConsignment(value, mint.issuer)
    if (typeof card === 'string')
      throw new ProtocolError(
        `The card mint sent a card that is not genuine: ${card}.`
      )
    if (card.consignment.mint !== mint.withdraw)
      throw new ProtocolError('The card mint sent a card of another mint.')
    if (!equalBytes(card.head.owner, owner))
      throw new ProtocolError('The card mint sent a card another key holds.')
    return card
  })
}

/** Where a card's moves go: the callback its informational GET names. */
export const moveCallback = async (
  net: Net,
  mint: CardMintInfo,
  head: CardState
): Promise<string> =>
  (await fetchNoteInfo(net, mint.withdraw, {p: encodeCp1(cardNote(head).q)}))
    .callback

/**
 * Sends a move to the card mint and checks its receipt. Asking again with
 * the same move is a replay (LUD-25, Retrying a mutation), which is why
 * the callback is kept: once the move landed, the card's old note is spent
 * and its informational GET names no callback any more.
 */
export const sendMove = async (
  net: Net,
  mint: CardMintInfo,
  callback: string,
  head: CardState,
  move: Move
): Promise<Uint8Array> => {
  const url = requireServiceUrl(callback)
  if (url.origin !== new URL(mint.withdraw).origin)
    throw new ProtocolError('The card mint named a callback on another origin.')
  url.searchParams.set('k1', move.k1)
  url.searchParams.set('p1', move.p1)
  url.searchParams.set('state', move.state)
  const body = await net.get(url.toString(), {secret: true})
  const receipt =
    typeof body.receipt === 'string' && /^[0-9a-f]{128}$/.test(body.receipt)
      ? hexToBytes(body.receipt)
      : null
  if (body.status !== 'OK' || !receipt)
    throw new ProtocolError('The card mint moved nothing it would vouch for.')
  const digest = moveDigest(head, move.next, spendDomain(mint.withdraw))
  if (!schnorr.verify(receipt, digest, mint.issuer))
    throw new ProtocolError('The card mint’s receipt does not verify.')
  return receipt
}

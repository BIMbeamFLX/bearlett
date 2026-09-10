import {schnorr} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {nutftMintUrl} from '../../host/nutft-contract'

/**
 * The mint's supply ledger, verified.
 *
 * A collection is worth what it is scarce, and scarcity is a claim about the
 * mint's books. The mint signs those books on a timer: one Nostr event per
 * snapshot, signed with the catalogue key this wallet already trusts, each
 * naming the one before it. The format is the mint's
 * `docs/nutft-supply-ledger.md`. This module checks a chain of them and
 * refuses the lot if any link is wrong. It is pure: events in, verdict out.
 * Fetching and remembering live at the bottom, behind injected `fetch` and
 * storage.
 *
 * What is checked, in order: every event is signed by the issuer and hashes
 * to its own id; it names this collection and census; the sequence is
 * complete from 1 with each event naming its predecessor; remaining counts
 * cover exactly the printed cards and never grow; packs sold never shrink;
 * the books balance, printed − remaining = sold × issued_per_pack; and the
 * commitment moves exactly when the pack count does. A witness remembered
 * from an earlier session must still be in the chain at its sequence number,
 * or the mint has rewritten its history.
 */

export const SUPPLY_KIND = 7610
export const SUPPLY_SCHEMA = '600b-nutft-supply-v1'

export type NostrEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export type SupplySnapshot = {
  id: string
  seq: number
  prev: string | null
  /** Unix seconds, the event's `created_at`. */
  at: number
  /** The mint's commitment when the snapshot was taken. */
  state: string
  packs: number
  issuedPerPack: number
  sold: number
  /** Copies still at the mint, one entry per printed card. */
  remaining: Readonly<Record<string, number>>
}

export type SupplyExpectation = {
  /** The catalogue issuer, x-only hex. */
  issuer: string
  collectionId: string
  censusSha256: string
  catalogUri?: string
  /** Every catalogue entry. Only those with printed copies are counted. */
  assets: readonly {asset_id: string; copies: number | null}[]
}

/** The last snapshot a wallet saw: enough to catch a rewritten history. */
export type SupplyWitness = {seq: number; id: string}

export type SupplyChain = {
  snapshots: readonly SupplySnapshot[]
  latest: SupplySnapshot
}

export class SupplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SupplyError'
  }
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

/* A declaration, not an arrow: TypeScript only narrows after a call it can
   see returns `never`, and it only sees that on a declared function. */
function fail(message: string): never {
  throw new SupplyError(message)
}

/** NIP-01: the id is the SHA-256 of exactly this serialisation. */
export function eventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ])
  return bytesToHex(sha256(utf8ToBytes(serialized)))
}

const isEvent = (value: unknown): value is NostrEvent => {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    HEX64.test(e.id) &&
    typeof e.pubkey === 'string' &&
    HEX64.test(e.pubkey) &&
    Number.isInteger(e.created_at) &&
    (e.created_at as number) >= 0 &&
    Number.isInteger(e.kind) &&
    Array.isArray(e.tags) &&
    e.tags.every(
      tag => Array.isArray(tag) && tag.every(item => typeof item === 'string')
    ) &&
    typeof e.content === 'string' &&
    typeof e.sig === 'string' &&
    HEX128.test(e.sig)
  )
}

/** True when the event hashes to its id and the signature is its author's. */
export function verifyEvent(event: NostrEvent): boolean {
  if (!isEvent(event) || eventId(event) !== event.id) return false
  try {
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey)
    )
  } catch {
    return false
  }
}

/** Printed copies per counted card. A card without copies is not counted. */
const printedOf = (
  assets: SupplyExpectation['assets']
): ReadonlyMap<string, number> => {
  const printed = new Map<string, number>()
  for (const asset of assets)
    if (Number.isInteger(asset.copies) && (asset.copies as number) > 0)
      printed.set(asset.asset_id, asset.copies as number)
  return printed
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** One event on its own: signature, identity, shape, and balanced books. */
export function parseSupplyEvent(
  event: unknown,
  expect: SupplyExpectation
): SupplySnapshot {
  if (!isEvent(event)) fail('The supply record is not a well-formed event.')
  if (event.kind !== SUPPLY_KIND)
    fail('The supply record is not a supply snapshot.')
  if (event.pubkey !== expect.issuer.toLowerCase())
    fail("The supply record is not signed by this collection's issuer.")
  if (!verifyEvent(event))
    fail("The supply record's signature does not check out.")

  let content: unknown
  try {
    content = JSON.parse(event.content)
  } catch {
    fail('The supply record does not carry readable figures.')
  }
  if (!isRecord(content))
    fail('The supply record does not carry readable figures.')
  if (content.schema !== SUPPLY_SCHEMA)
    fail('The supply record uses a format this wallet does not read.')
  if (content.collection_id !== expect.collectionId)
    fail('The supply record belongs to another collection.')
  if (content.census_sha256 !== expect.censusSha256)
    fail('The supply record counts a different census.')
  if (
    expect.catalogUri !== undefined &&
    content.catalog_uri !== expect.catalogUri
  )
    fail('The supply record names another catalogue.')

  const census = event.tags.filter(tag => tag[0] === 'x')
  if (census.length !== 1 || census[0]?.[1] !== expect.censusSha256)
    fail('The supply record is not tagged with this census.')

  const seq = content.seq
  if (!Number.isInteger(seq) || (seq as number) < 1)
    fail('The supply record has no sequence number.')
  const prev = content.prev
  if (prev !== null && !(typeof prev === 'string' && HEX64.test(prev)))
    fail('The supply record does not name its predecessor properly.')
  const links = event.tags.filter(tag => tag[0] === 'e')
  const linked =
    prev === null
      ? links.length === 0
      : links.length === 1 && links[0]?.[1] === prev && links[0]?.[3] === 'prev'
  if (!linked) fail("The supply record's chain tag disagrees with its figures.")

  const state = content.state
  if (typeof state !== 'string' || !HEX64.test(state))
    fail("The supply record's commitment is malformed.")
  for (const key of ['packs', 'issued_per_pack', 'sold'] as const)
    if (!Number.isInteger(content[key]) || (content[key] as number) < 0)
      fail(`The supply record's ${key.replace('_', ' ')} is not a count.`)
  const packs = content.packs as number
  const issuedPerPack = content.issued_per_pack as number
  const sold = content.sold as number
  if (packs < 1 || issuedPerPack < 1)
    fail('The supply record describes an edition with nothing in it.')
  if (sold > packs)
    fail('The supply record sells more packs than the edition has.')

  const counts = content.remaining
  if (!isRecord(counts)) fail('The supply record has no remaining counts.')
  const printed = printedOf(expect.assets)
  if (Object.keys(counts).length !== printed.size)
    fail('The supply record does not count exactly the printed cards.')
  let left = 0
  let total = 0
  const remaining: Record<string, number> = {}
  for (const [id, copies] of printed) {
    const n = Object.hasOwn(counts, id) ? counts[id] : undefined
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > copies)
      fail(`The supply record's count for ${id} is outside what was printed.`)
    remaining[id] = n as number
    left += n as number
    total += copies
  }
  if (total - left !== sold * issuedPerPack)
    fail(
      'The supply record does not balance: cards issued do not match packs sold.'
    )

  return {
    id: event.id,
    seq: seq as number,
    prev: prev as string | null,
    at: event.created_at,
    state,
    packs,
    issuedPerPack,
    sold,
    remaining: Object.freeze(remaining)
  }
}

/**
 * The whole chain, or nothing. Every event is checked on its own, then the
 * links between them, then the witness. The first thing wrong is the error.
 */
export function verifySupplyChain(
  events: readonly unknown[],
  expect: SupplyExpectation,
  witness?: SupplyWitness | null
): SupplyChain {
  if (!Array.isArray(events) || !events.length)
    fail('The mint has published no supply record yet.')
  const snapshots = events
    .map(event => parseSupplyEvent(event, expect))
    .sort((a, b) => a.seq - b.seq)
  const first = snapshots[0]
  if (!first || first.seq !== 1 || first.prev !== null)
    fail('The supply record does not start at its first snapshot.')
  for (let i = 1; i < snapshots.length; i++) {
    const before = snapshots[i - 1]!
    const here = snapshots[i]!
    if (here.seq === before.seq)
      fail('The supply record carries two snapshots with the same number.')
    if (here.seq !== before.seq + 1) fail('The supply record skips a snapshot.')
    if (here.prev !== before.id)
      fail('A supply snapshot does not name the one before it.')
    if (here.at < before.at)
      fail('A supply snapshot is dated before the one it follows.')
    if (
      here.packs !== before.packs ||
      here.issuedPerPack !== before.issuedPerPack
    )
      fail('The supply record changes the size of the edition.')
    if (here.sold < before.sold) fail('The supply record un-sells packs.')
    for (const id of Object.keys(before.remaining))
      if (here.remaining[id]! > before.remaining[id]!)
        fail(`The supply record grows the stock of ${id}.`)
    if ((here.sold === before.sold) !== (here.state === before.state))
      fail('The supply record moves its commitment apart from its pack count.')
  }
  if (witness) {
    const seen = snapshots[witness.seq - 1]
    if (!seen)
      fail('The supply record is shorter than what this wallet saw before.')
    if (seen.id !== witness.id)
      fail('The mint has rewritten a supply snapshot this wallet saw before.')
  }
  return {snapshots, latest: snapshots[snapshots.length - 1]!}
}

export type IssuedCount = {issued: number; copies: number}

/** Issued so far per counted card, from the latest snapshot. */
export function issuedCounts(
  snapshot: SupplySnapshot,
  assets: SupplyExpectation['assets']
): ReadonlyMap<string, IssuedCount> {
  const issued = new Map<string, IssuedCount>()
  for (const [id, copies] of printedOf(assets)) {
    const left = snapshot.remaining[id]
    if (left !== undefined) issued.set(id, {issued: copies - left, copies})
  }
  return issued
}

/** The storage key under which a collection remembers its witness. */
export const supplyWitnessKeyFor = (edition: {id: string}): string =>
  `bearlett:nutft:${edition.id}:supply`

const readWitness = (raw: string | null): SupplyWitness | null => {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (
      isRecord(value) &&
      Number.isInteger(value.seq) &&
      (value.seq as number) >= 1 &&
      typeof value.id === 'string' &&
      HEX64.test(value.id)
    )
      return {seq: value.seq as number, id: value.id}
  } catch {
    /* A witness this wallet cannot read is no witness. */
  }
  return null
}

export type SupplyDeps = {
  /** The collection router: it maps the mint URL onto the `supply` operation. */
  fetch: typeof fetch
  storage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
  }
  edition: {id: string; mint: string}
  expect: SupplyExpectation
}

/**
 * Fetch the chain from the mint, verify it against the catalogue and the
 * remembered witness, and remember the new head. The witness only advances
 * on a verified chain, so a bad answer can never erase what was seen.
 */
export async function loadSupply(deps: SupplyDeps): Promise<SupplyChain> {
  const key = supplyWitnessKeyFor(deps.edition)
  const witness = readWitness(await deps.storage.getItem(key))
  const response = await deps.fetch(
    nutftMintUrl(deps.edition.mint) + '/nutft/supply'
  )
  if (!response.ok) fail('The mint did not answer for its supply record.')
  let body: unknown
  try {
    body = await response.json()
  } catch {
    fail("The mint's supply record is not readable.")
  }
  if (!isRecord(body)) fail("The mint's supply record is not readable.")
  if (typeof body.fault === 'string' && body.fault)
    fail(
      `The mint reports that its own books do not balance: ${body.fault.slice(0, 200)}`
    )
  const events = Array.isArray(body.events) ? body.events : []
  const chain = verifySupplyChain(events, deps.expect, witness)
  if (!witness || chain.latest.seq > witness.seq)
    await deps.storage.setItem(
      key,
      JSON.stringify({seq: chain.latest.seq, id: chain.latest.id})
    )
  return chain
}

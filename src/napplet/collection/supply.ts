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
 * `docs/nutft-supply-ledger.md`. This module checks them and refuses the lot
 * if any link is wrong. It is pure: events in, verdict out. Fetching and
 * remembering live at the bottom, behind injected `fetch` and storage.
 *
 * What is checked, in order: every event is signed by the issuer and hashes
 * to its own id; it names this collection and census; sequence numbers run
 * consecutively with each event naming its predecessor; remaining counts
 * cover exactly the printed cards and never grow; packs sold never shrink;
 * and the books balance, printed − remaining = sold × issued_per_pack. A
 * snapshot remembered from an earlier session must still carry the same id
 * at the same sequence number, and the figures must not have moved backwards
 * since, or the mint has rewritten its history.
 *
 * The mint serves a PAGE, not the whole chain. A snapshot carries one count
 * per printed card, so the chain outgrows any single response eventually;
 * `verifySupplyPage` therefore checks a window that need not begin at the
 * first snapshot, and `loadSupply` stitches the remembered one to it.
 *
 * The figures are ISSUED cards, not allocated ones. A mint that takes
 * committed purchases reserves a pack before anyone claims it and puts it
 * back if nobody does, so its own counts rise and fall; the ledger gives
 * those reservations back before signing, which is what makes "no count ever
 * grows" a sound thing to insist on. The mint's draw commitment follows
 * allocation and is deliberately not in a snapshot, so there is nothing here
 * that checks it.
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

/** The parts of a snapshot that may only ever move one way. */
export type SupplyFigures = Pick<
  SupplySnapshot,
  'packs' | 'issuedPerPack' | 'sold' | 'remaining'
>

/**
 * The last snapshot a wallet saw, kept between sessions.
 *
 * The id catches a mint that rewrote that snapshot. The figures beside it are
 * what let a wallet that has been away longer than one page hold the mint to
 * them without fetching everything in between: whatever the mint serves now
 * has to have moved forward from these. The census is stored too, so a
 * witness left over from a different edition is discarded rather than
 * compared against figures it was never about.
 */
export type SupplyWitness = SupplyFigures & {
  seq: number
  id: string
  censusSha256: string
}

/** One verified page of the chain, oldest first. */
export type SupplyPage = {
  snapshots: readonly SupplySnapshot[]
  oldest: SupplySnapshot
  latest: SupplySnapshot
}

export type SupplyChain = SupplyPage & {
  /** The newest sequence number the mint says exists. */
  total: number
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
    packs,
    issuedPerPack,
    sold,
    remaining: Object.freeze(remaining)
  }
}

/**
 * Everything that must hold between an earlier set of figures and a later
 * one. Used between neighbours on a page, and across a gap between what this
 * wallet remembers and the oldest snapshot the mint now serves.
 */
export function stillGoingForward(
  before: SupplyFigures,
  here: SupplyFigures
): void {
  if (
    here.packs !== before.packs ||
    here.issuedPerPack !== before.issuedPerPack
  )
    fail('The supply record changes the size of the edition.')
  if (here.sold < before.sold) fail('The supply record un-sells packs.')
  for (const id of Object.keys(before.remaining)) {
    const later = here.remaining[id]
    if (later === undefined) fail(`The supply record stops counting ${id}.`)
    if (later > before.remaining[id]!)
      fail(`The supply record grows the stock of ${id}.`)
  }
}

/**
 * One page, or nothing. Every event is checked on its own, then the links
 * between them.
 *
 * A page need not begin at the first snapshot. The mint serves at most a
 * hundred at a time: the newest by default, or the page beginning at a
 * requested sequence number. So a page that starts at 1 must name no
 * predecessor, and a page that starts anywhere else must name one it does not
 * itself carry. What a page cannot tell you on its own is whether it descends
 * from what you saw last time; that is the witness, in `loadSupply`.
 */
export function verifySupplyPage(
  events: readonly unknown[],
  expect: SupplyExpectation
): SupplyPage {
  if (!Array.isArray(events) || !events.length)
    fail('The mint has published no supply record yet.')
  const snapshots = events
    .map(event => parseSupplyEvent(event, expect))
    .sort((a, b) => a.seq - b.seq)
  const first = snapshots[0]!
  if (first.seq === 1) {
    if (first.prev !== null)
      fail('The first supply snapshot names a predecessor it cannot have.')
  } else if (first.prev === null)
    fail(
      'A supply snapshot away from the start of the chain names no predecessor.'
    )
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
    stillGoingForward(before, here)
  }
  return {snapshots, oldest: first, latest: snapshots[snapshots.length - 1]!}
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

/**
 * What this wallet wrote down last time, or nothing. Anything unreadable,
 * malformed, or about a different census is discarded rather than repaired:
 * a witness is only useful if it is exactly what was verified, and starting
 * over costs nothing but one session of history.
 */
const readWitness = (
  raw: string | null,
  censusSha256: string
): SupplyWitness | null => {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!isRecord(v) || v.censusSha256 !== censusSha256) return null
    const counts = v.remaining
    if (!isRecord(counts)) return null
    const whole = (value: unknown, least: number) =>
      Number.isInteger(value) && (value as number) >= least
    if (
      !whole(v.seq, 1) ||
      !whole(v.sold, 0) ||
      !whole(v.packs, 1) ||
      !whole(v.issuedPerPack, 1) ||
      typeof v.id !== 'string' ||
      !HEX64.test(v.id)
    )
      return null
    const remaining: Record<string, number> = {}
    for (const [id, left] of Object.entries(counts)) {
      if (!whole(left, 0)) return null
      remaining[id] = left as number
    }
    return {
      seq: v.seq as number,
      id: v.id,
      censusSha256,
      packs: v.packs as number,
      issuedPerPack: v.issuedPerPack as number,
      sold: v.sold as number,
      remaining
    }
  } catch {
    /* A witness this wallet cannot read is no witness. */
  }
  return null
}

const witnessOf = (
  snapshot: SupplySnapshot,
  censusSha256: string
): SupplyWitness => ({
  seq: snapshot.seq,
  id: snapshot.id,
  censusSha256,
  packs: snapshot.packs,
  issuedPerPack: snapshot.issuedPerPack,
  sold: snapshot.sold,
  remaining: snapshot.remaining
})

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

/** One page from the mint, verified, with the chain length it reports. */
async function readPage(
  deps: SupplyDeps,
  from?: number
): Promise<{page: SupplyPage; total: number}> {
  const mint = nutftMintUrl(deps.edition.mint) + '/nutft/supply'
  const response = await deps.fetch(
    from === undefined ? mint : `${mint}?from=${from}`
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
  const page = verifySupplyPage(
    Array.isArray(body.events) ? body.events : [],
    deps.expect
  )
  /* An older mint that serves the whole chain and no `total` is read as
     "this page is all of it", which is exactly what it is there. */
  const total = Number.isInteger(body.total)
    ? (body.total as number)
    : page.latest.seq
  if (total < page.latest.seq)
    fail('The mint says its supply record is shorter than what it just served.')
  return {page, total}
}

/**
 * Read the mint's supply record, hold it to what this wallet saw last time,
 * and write down the new head.
 *
 * The mint serves a page, not the whole chain, so this takes one request in
 * the ordinary case and two after a long absence:
 *
 *   - The newest page always comes first. Each snapshot balances its own
 *     books, so the current figures stand on their own.
 *   - If the remembered snapshot is on that page, its id must match, and the
 *     page's own checks cover everything since.
 *   - If it is older than the page, one more request asks for it by sequence
 *     number: the mint must still sign the same id there, and the remembered
 *     figures must not have moved backwards on the way to the newest page.
 *
 * That is two requests whatever the size of the gap. Walking every page in
 * between would be stricter, but the checks above already catch the two
 * things the chain exists to catch: a rewritten snapshot, and figures that
 * went the wrong way.
 *
 * The witness only ever advances on a page that verified, so a bad answer
 * cannot erase what this wallet already knows.
 */
export async function loadSupply(deps: SupplyDeps): Promise<SupplyChain> {
  const key = supplyWitnessKeyFor(deps.edition)
  const witness = readWitness(
    await deps.storage.getItem(key),
    deps.expect.censusSha256
  )
  const {page, total} = await readPage(deps)

  if (witness) {
    const shorter =
      'The supply record is shorter than what this wallet saw before.'
    const rewritten =
      'The mint has rewritten a supply snapshot this wallet saw before.'
    if (witness.seq > total) fail(shorter)
    if (witness.seq >= page.oldest.seq) {
      const seen = page.snapshots[witness.seq - page.oldest.seq]
      if (!seen || seen.seq !== witness.seq) fail(shorter)
      if (seen.id !== witness.id) fail(rewritten)
    } else {
      const older = await readPage(deps, witness.seq)
      if (older.page.oldest.seq !== witness.seq)
        fail(
          'The mint did not serve the supply snapshot this wallet asked for.'
        )
      if (older.page.oldest.id !== witness.id) fail(rewritten)
      stillGoingForward(witness, page.oldest)
    }
  }

  if (!witness || page.latest.seq > witness.seq)
    await deps.storage.setItem(
      key,
      JSON.stringify(witnessOf(page.latest, deps.expect.censusSha256))
    )
  return {...page, total}
}

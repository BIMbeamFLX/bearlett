import {describe, expect, it} from 'vitest'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  SUPPLY_KIND,
  SUPPLY_SCHEMA,
  SupplyError,
  eventId,
  issuedCounts,
  loadSupply,
  parseSupplyEvent,
  supplyWitnessKeyFor,
  verifyEvent,
  verifySupplyChain
} from './supply'
import type {NostrEvent, SupplyExpectation} from './supply'

/* A mint in miniature: two printed cards and one free basic, three packs of
   two counted cards each. The signer mirrors the mint's: BIP-340 with zero
   auxiliary randomness over the NIP-01 id. */
const KEY = new Uint8Array(32).fill(7)
const ISSUER = bytesToHex(schnorr.getPublicKey(KEY))
const OTHER_KEY = new Uint8Array(32).fill(9)
const CENSUS = 'c'.repeat(64)
const CATALOG = 'https://mint.example/nutft/catalog'
const EXPECT: SupplyExpectation = {
  issuer: ISSUER,
  collectionId: '600B-T',
  censusSha256: CENSUS,
  catalogUri: CATALOG,
  assets: [
    {asset_id: 'T-001', copies: 4},
    {asset_id: 'T-002', copies: 2},
    {asset_id: 'T-BASIC', copies: null}
  ]
}

/* The mint's canonical(): keys sorted, no whitespace. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`
  return JSON.stringify(value)
}

type Figures = {
  seq: number
  prev: string | null
  sold: number
  remaining: Record<string, number>
  at?: number
  packs?: number
  issuedPerPack?: number
  key?: Uint8Array
  kind?: number
  tags?: string[][]
  content?: Record<string, unknown>
}

function snapshotEvent(figures: Figures): NostrEvent {
  const key = figures.key ?? KEY
  const content = canonical({
    schema: SUPPLY_SCHEMA,
    collection_id: '600B-T',
    catalog_uri: CATALOG,
    census_sha256: CENSUS,
    seq: figures.seq,
    prev: figures.prev,
    packs: figures.packs ?? 3,
    issued_per_pack: figures.issuedPerPack ?? 2,
    sold: figures.sold,
    remaining: figures.remaining,
    ...(figures.content ?? {})
  })
  const tags = figures.tags ?? [
    ['x', CENSUS],
    ...(figures.prev ? [['e', figures.prev, '', 'prev']] : [])
  ]
  const unsigned = {
    pubkey: bytesToHex(schnorr.getPublicKey(key)),
    created_at: figures.at ?? 1_700_000_000 + figures.seq,
    kind: figures.kind ?? SUPPLY_KIND,
    tags,
    content
  }
  const id = eventId(unsigned)
  return {
    ...unsigned,
    id,
    sig: bytesToHex(schnorr.sign(hexToBytes(id), key, new Uint8Array(32)))
  }
}

/* Three snapshots: nothing issued, one pack, two packs. */
function chain(): NostrEvent[] {
  const one = snapshotEvent({
    seq: 1,
    prev: null,
    sold: 0,
    remaining: {'T-001': 4, 'T-002': 2}
  })
  const two = snapshotEvent({
    seq: 2,
    prev: one.id,
    sold: 1,
    remaining: {'T-001': 3, 'T-002': 1}
  })
  const three = snapshotEvent({
    seq: 3,
    prev: two.id,
    sold: 2,
    remaining: {'T-001': 1, 'T-002': 1}
  })
  return [one, two, three]
}

const rejects = (
  events: unknown[],
  pattern: RegExp,
  witness?: {seq: number; id: string}
) => expect(() => verifySupplyChain(events, EXPECT, witness)).toThrow(pattern)

describe('parseSupplyEvent', () => {
  it('accepts a snapshot the issuer signed and reads its figures', () => {
    const [one] = chain()
    expect(verifyEvent(one!)).toBe(true)
    const snapshot = parseSupplyEvent(one, EXPECT)
    expect(snapshot).toMatchObject({
      id: one!.id,
      seq: 1,
      prev: null,
      sold: 0,
      packs: 3,
      issuedPerPack: 2,
      remaining: {'T-001': 4, 'T-002': 2}
    })
    expect(Object.isFrozen(snapshot.remaining)).toBe(true)
  })

  it('throws a SupplyError, never a plain one', () => {
    expect(() => parseSupplyEvent({}, EXPECT)).toThrow(SupplyError)
  })

  it('refuses a snapshot whose figures were edited after signing', () => {
    const [one] = chain()
    const edited = {
      ...one!,
      content: one!.content.replace('"sold":0', '"sold":1')
    }
    expect(verifyEvent(edited)).toBe(false)
    expect(() => parseSupplyEvent(edited, EXPECT)).toThrow(/signature/)
  })

  it('refuses a snapshot signed by anyone but the catalogue issuer', () => {
    const foreign = snapshotEvent({
      seq: 1,
      prev: null,
      sold: 0,
      remaining: {'T-001': 4, 'T-002': 2},
      key: OTHER_KEY
    })
    expect(verifyEvent(foreign)).toBe(true)
    expect(() => parseSupplyEvent(foreign, EXPECT)).toThrow(/issuer/)
  })

  it('refuses the wrong kind, collection, census, catalogue or schema', () => {
    const base = {
      seq: 1,
      prev: null,
      sold: 0,
      remaining: {'T-001': 4, 'T-002': 2}
    } as const
    const bad = (over: Partial<Figures>) => () =>
      parseSupplyEvent(snapshotEvent({...base, ...over}), EXPECT)
    expect(bad({kind: 7600})).toThrow(/not a supply snapshot/)
    expect(bad({content: {collection_id: '600B-X'}})).toThrow(
      /another collection/
    )
    expect(bad({content: {census_sha256: 'd'.repeat(64)}})).toThrow(
      /different census/
    )
    expect(
      bad({content: {catalog_uri: 'https://elsewhere.example/c'}})
    ).toThrow(/another catalogue/)
    expect(bad({content: {schema: 'v2'}})).toThrow(/format/)
    expect(bad({tags: [['x', 'd'.repeat(64)]]})).toThrow(/tagged/)
    expect(bad({tags: []})).toThrow(/tagged/)
  })

  it('refuses a chain tag that disagrees with the figures', () => {
    const [one] = chain()
    const linked = {sold: 1, remaining: {'T-001': 3, 'T-002': 1}} as const
    const detached = snapshotEvent({
      seq: 2,
      prev: one!.id,
      ...linked,
      tags: [['x', CENSUS]]
    })
    expect(() => parseSupplyEvent(detached, EXPECT)).toThrow(/chain tag/)
    const misdirected = snapshotEvent({
      seq: 2,
      prev: one!.id,
      ...linked,
      tags: [
        ['x', CENSUS],
        ['e', 'e'.repeat(64), '', 'prev']
      ]
    })
    expect(() => parseSupplyEvent(misdirected, EXPECT)).toThrow(/chain tag/)
    const genesisWithLink = snapshotEvent({
      seq: 1,
      prev: null,
      sold: 0,
      remaining: {'T-001': 4, 'T-002': 2},
      tags: [
        ['x', CENSUS],
        ['e', one!.id, '', 'prev']
      ]
    })
    expect(() => parseSupplyEvent(genesisWithLink, EXPECT)).toThrow(/chain tag/)
  })

  it('refuses counts that do not cover exactly the printed cards', () => {
    const bad =
      (remaining: Record<string, number>, sold = 0) =>
      () =>
        parseSupplyEvent(
          snapshotEvent({seq: 1, prev: null, sold, remaining}),
          EXPECT
        )
    expect(bad({'T-001': 4})).toThrow(/exactly the printed cards/)
    expect(bad({'T-001': 4, 'T-003': 2})).toThrow(/T-002/)
    expect(bad({'T-001': 4, 'T-002': 2, 'T-BASIC': 0})).toThrow(
      /exactly the printed cards/
    )
    expect(bad({'T-001': 5, 'T-002': 1})).toThrow(/T-001/)
    expect(bad({'T-001': 4, 'T-002': -0.5})).toThrow(/T-002/)
  })

  it('refuses books that do not balance', () => {
    const bad = (sold: number, remaining: Record<string, number>) => () =>
      parseSupplyEvent(
        snapshotEvent({seq: 1, prev: null, sold, remaining}),
        EXPECT
      )
    expect(bad(1, {'T-001': 4, 'T-002': 2})).toThrow(/balance/)
    expect(bad(0, {'T-001': 3, 'T-002': 2})).toThrow(/balance/)
    expect(bad(4, {'T-001': 0, 'T-002': 0})).toThrow(
      /more packs than the edition has/
    )
  })

  it('does not look for a draw commitment, which the mint no longer signs', () => {
    const [one] = chain()
    expect('state' in JSON.parse(one!.content)).toBe(false)
    expect(parseSupplyEvent(one, EXPECT).seq).toBe(1)
  })
})

describe('verifySupplyChain', () => {
  it('accepts a complete chain and reports the latest snapshot', () => {
    const events = chain()
    const verified = verifySupplyChain([...events].reverse(), EXPECT)
    expect(verified.snapshots.map(s => s.seq)).toEqual([1, 2, 3])
    expect(verified.latest.id).toBe(events[2]!.id)
    expect(verified.latest.sold).toBe(2)
    const issued = issuedCounts(verified.latest, EXPECT.assets)
    expect([...issued]).toEqual([
      ['T-001', {issued: 3, copies: 4}],
      ['T-002', {issued: 1, copies: 2}]
    ])
  })

  it('wants the chain from its first snapshot', () => {
    rejects([], /no supply record/)
    rejects(chain().slice(1), /first snapshot/)
  })

  it('refuses a gap, a repeat, a broken link and a backwards date', () => {
    const [one, two, three] = chain()
    const later = {sold: 2, remaining: {'T-001': 1, 'T-002': 1}} as const
    rejects([one, three], /skips/)
    rejects([one, two, two], /same number/)
    rejects(
      [one, two, snapshotEvent({seq: 3, prev: one!.id, ...later})],
      /name the one before/
    )
    rejects(
      [one, two, snapshotEvent({seq: 3, prev: two!.id, ...later, at: 1})],
      /dated before/
    )
  })

  it('refuses stock that grows, packs that un-sell, and a resized edition', () => {
    const [one, two] = chain()
    rejects(
      [
        one,
        two,
        snapshotEvent({
          seq: 3,
          prev: two!.id,
          sold: 1,
          remaining: {'T-001': 4, 'T-002': 0}
        })
      ],
      /grows the stock of T-001/
    )
    rejects(
      [
        one,
        two,
        snapshotEvent({
          seq: 3,
          prev: two!.id,
          sold: 0,
          remaining: {'T-001': 4, 'T-002': 2}
        })
      ],
      /un-sells/
    )
    rejects(
      [
        one,
        two,
        snapshotEvent({
          seq: 3,
          prev: two!.id,
          sold: 2,
          remaining: {'T-001': 1, 'T-002': 1},
          packs: 4
        })
      ],
      /size of the edition/
    )
  })

  /* A quiet interval is normal: a reservation that opened and lapsed moves
     the mint's own counts but issues nothing, so a snapshot that repeats the
     figures verbatim must be accepted rather than read as a stalled chain. */
  it('accepts a snapshot that repeats the figures of the one before it', () => {
    const [one, two] = chain()
    const idle = snapshotEvent({
      seq: 3,
      prev: two!.id,
      sold: 1,
      remaining: {'T-001': 3, 'T-002': 1}
    })
    expect(verifySupplyChain([one, two, idle], EXPECT).latest.seq).toBe(3)
  })

  it('holds the mint to what this wallet saw before', () => {
    const [one, two, three] = chain()
    expect(
      verifySupplyChain([one, two, three], EXPECT, {seq: 2, id: two!.id}).latest
        .seq
    ).toBe(3)
    rejects([one, two, three], /rewritten/, {seq: 2, id: 'f'.repeat(64)})
    rejects([one, two], /shorter/, {seq: 3, id: three!.id})
  })
})

describe('loadSupply', () => {
  const edition = {id: 'six-t', mint: 'https://mint.example/t'}
  const memory = () => {
    const store = new Map<string, string>()
    return {
      store,
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        store.set(key, value)
      }
    }
  }
  const answering = (body: unknown, ok = true) => {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return {ok, json: async () => body} as Response
    }) as typeof fetch
    return {fetcher, calls}
  }

  it('asks the mint for the chain, verifies it and remembers the head', async () => {
    const events = chain()
    const storage = memory()
    const {fetcher, calls} = answering({fault: null, events})
    const verified = await loadSupply({
      fetch: fetcher,
      storage,
      edition,
      expect: EXPECT
    })
    expect(calls).toEqual(['https://mint.example/t/nutft/supply'])
    expect(verified.latest.seq).toBe(3)
    expect(
      JSON.parse(storage.store.get(supplyWitnessKeyFor(edition))!)
    ).toEqual({seq: 3, id: events[2]!.id})
  })

  it('does not advance the witness past what it verified', async () => {
    const events = chain()
    const storage = memory()
    storage.store.set(
      supplyWitnessKeyFor(edition),
      JSON.stringify({seq: 3, id: events[2]!.id})
    )
    const {fetcher} = answering({fault: null, events: events.slice(0, 2)})
    await expect(
      loadSupply({fetch: fetcher, storage, edition, expect: EXPECT})
    ).rejects.toThrow(/shorter/)
    expect(
      JSON.parse(storage.store.get(supplyWitnessKeyFor(edition))!)
    ).toEqual({seq: 3, id: events[2]!.id})
  })

  it('catches a rewritten history and keeps its own record', async () => {
    const storage = memory()
    const before = JSON.stringify({seq: 2, id: 'a'.repeat(64)})
    storage.store.set(supplyWitnessKeyFor(edition), before)
    const {fetcher} = answering({fault: null, events: chain()})
    await expect(
      loadSupply({fetch: fetcher, storage, edition, expect: EXPECT})
    ).rejects.toThrow(/rewritten/)
    expect(storage.store.get(supplyWitnessKeyFor(edition))).toBe(before)
  })

  it('passes on a fault the mint reports about its own books', async () => {
    const {fetcher} = answering({
      fault: 'packs sold went from 1 to 0',
      events: chain()
    })
    await expect(
      loadSupply({fetch: fetcher, storage: memory(), edition, expect: EXPECT})
    ).rejects.toThrow(/own books do not balance: packs sold went from 1 to 0/)
  })

  it('treats a bad answer as no answer', async () => {
    const bad = (body: unknown, ok = true) =>
      loadSupply({
        fetch: answering(body, ok).fetcher,
        storage: memory(),
        edition,
        expect: EXPECT
      })
    await expect(bad({}, false)).rejects.toThrow(/did not answer/)
    await expect(bad([])).rejects.toThrow(/not readable/)
    await expect(bad({events: 'no'})).rejects.toThrow(/no supply record/)
  })

  it('ignores a witness it cannot read rather than trusting it', async () => {
    const storage = memory()
    storage.store.set(supplyWitnessKeyFor(edition), '{"seq":"two"}')
    const {fetcher} = answering({fault: null, events: chain()})
    expect(
      (await loadSupply({fetch: fetcher, storage, edition, expect: EXPECT}))
        .latest.seq
    ).toBe(3)
  })
})

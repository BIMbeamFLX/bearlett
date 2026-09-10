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
  stillGoingForward,
  supplyWitnessKeyFor,
  verifyEvent,
  verifySupplyPage
} from './supply'
import type {NostrEvent, SupplyExpectation, SupplyWitness} from './supply'

/* A mint in miniature: two printed cards and one free basic, fifteen packs
   of two counted cards each. The signer mirrors the mint's: BIP-340 with zero
   auxiliary randomness over the NIP-01 id. */
const KEY = new Uint8Array(32).fill(7)
const ISSUER = bytesToHex(schnorr.getPublicKey(KEY))
const OTHER_KEY = new Uint8Array(32).fill(9)
const CENSUS = 'c'.repeat(64)
const CATALOG = 'https://mint.example/nutft/catalog'
const PACKS = 15
const EXPECT: SupplyExpectation = {
  issuer: ISSUER,
  collectionId: '600B-T',
  censusSha256: CENSUS,
  catalogUri: CATALOG,
  assets: [
    {asset_id: 'T-001', copies: 20},
    {asset_id: 'T-002', copies: 10},
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
    packs: figures.packs ?? PACKS,
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

/* A chain of `length` snapshots: snapshot N has sold N−1 packs, so the first
   has issued nothing and each one after it takes two more cards off T-001
   until it runs out, then off T-002. */
function chainOf(length: number): NostrEvent[] {
  const events: NostrEvent[] = []
  let prev: string | null = null
  for (let seq = 1; seq <= length; seq++) {
    const gone = (seq - 1) * 2
    const event = snapshotEvent({
      seq,
      prev,
      sold: seq - 1,
      remaining: {
        'T-001': Math.max(0, 20 - gone),
        'T-002': 10 - Math.max(0, gone - 20)
      }
    })
    events.push(event)
    prev = event.id
  }
  return events
}

const chain = () => chainOf(3)

const rejects = (events: unknown[], pattern: RegExp) =>
  expect(() => verifySupplyPage(events, EXPECT)).toThrow(pattern)

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
      packs: PACKS,
      issuedPerPack: 2,
      remaining: {'T-001': 20, 'T-002': 10}
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
      remaining: {'T-001': 20, 'T-002': 10},
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
      remaining: {'T-001': 20, 'T-002': 10}
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
    const linked = {sold: 1, remaining: {'T-001': 18, 'T-002': 10}} as const
    const bad = (over: Partial<Figures>) => () =>
      parseSupplyEvent(
        snapshotEvent({seq: 2, prev: one!.id, ...linked, ...over}),
        EXPECT
      )
    expect(bad({tags: [['x', CENSUS]]})).toThrow(/chain tag/)
    expect(
      bad({
        tags: [
          ['x', CENSUS],
          ['e', 'e'.repeat(64), '', 'prev']
        ]
      })
    ).toThrow(/chain tag/)
    expect(() =>
      parseSupplyEvent(
        snapshotEvent({
          seq: 1,
          prev: null,
          sold: 0,
          remaining: {'T-001': 20, 'T-002': 10},
          tags: [
            ['x', CENSUS],
            ['e', one!.id, '', 'prev']
          ]
        }),
        EXPECT
      )
    ).toThrow(/chain tag/)
  })

  it('refuses counts that do not cover exactly the printed cards', () => {
    const bad =
      (remaining: Record<string, number>, sold = 0) =>
      () =>
        parseSupplyEvent(
          snapshotEvent({seq: 1, prev: null, sold, remaining}),
          EXPECT
        )
    expect(bad({'T-001': 20})).toThrow(/exactly the printed cards/)
    expect(bad({'T-001': 20, 'T-003': 10})).toThrow(/T-002/)
    expect(bad({'T-001': 20, 'T-002': 10, 'T-BASIC': 0})).toThrow(
      /exactly the printed cards/
    )
    expect(bad({'T-001': 21, 'T-002': 9})).toThrow(/T-001/)
    expect(bad({'T-001': 20, 'T-002': -0.5})).toThrow(/T-002/)
  })

  it('refuses books that do not balance', () => {
    const bad = (sold: number, remaining: Record<string, number>) => () =>
      parseSupplyEvent(
        snapshotEvent({seq: 1, prev: null, sold, remaining}),
        EXPECT
      )
    expect(bad(1, {'T-001': 20, 'T-002': 10})).toThrow(/balance/)
    expect(bad(0, {'T-001': 19, 'T-002': 10})).toThrow(/balance/)
    expect(bad(16, {'T-001': 0, 'T-002': 0})).toThrow(
      /more packs than the edition has/
    )
  })

  it('does not look for a draw commitment, which the mint no longer signs', () => {
    const [one] = chain()
    expect('state' in JSON.parse(one!.content)).toBe(false)
    expect(parseSupplyEvent(one, EXPECT).seq).toBe(1)
  })
})

describe('verifySupplyPage', () => {
  it('accepts a page and reports its ends', () => {
    const events = chain()
    const page = verifySupplyPage([...events].reverse(), EXPECT)
    expect(page.snapshots.map(s => s.seq)).toEqual([1, 2, 3])
    expect(page.oldest.id).toBe(events[0]!.id)
    expect(page.latest.id).toBe(events[2]!.id)
    expect(page.latest.sold).toBe(2)
    expect([...issuedCounts(page.latest, EXPECT.assets)]).toEqual([
      ['T-001', {issued: 4, copies: 20}],
      ['T-002', {issued: 0, copies: 10}]
    ])
  })

  /* The whole point of paging: a window that starts in the middle. */
  it('accepts a page that does not begin at the first snapshot', () => {
    const page = verifySupplyPage(chainOf(5).slice(2), EXPECT)
    expect(page.oldest.seq).toBe(3)
    expect(page.latest.seq).toBe(5)
    expect(page.oldest.prev).not.toBe(null)
  })

  it('wants a first snapshot with no predecessor, and a later one with one', () => {
    rejects([], /no supply record/)
    const orphan = snapshotEvent({
      seq: 4,
      prev: null,
      sold: 3,
      remaining: {'T-001': 14, 'T-002': 10}
    })
    rejects([orphan], /names no predecessor/)
    const [one] = chain()
    rejects(
      [
        snapshotEvent({
          seq: 1,
          prev: one!.id,
          sold: 0,
          remaining: {'T-001': 20, 'T-002': 10}
        })
      ],
      /cannot have/
    )
  })

  it('refuses a gap, a repeat, a broken link and a backwards date', () => {
    const [one, two, three] = chain()
    const later = {sold: 2, remaining: {'T-001': 16, 'T-002': 10}} as const
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
    const at3 = (over: Partial<Figures>) =>
      snapshotEvent({
        seq: 3,
        prev: two!.id,
        sold: 2,
        remaining: {'T-001': 16, 'T-002': 10},
        ...over
      })
    rejects(
      [one, two, at3({sold: 1, remaining: {'T-001': 20, 'T-002': 8}})],
      /grows the stock of T-001/
    )
    rejects(
      [one, two, at3({sold: 0, remaining: {'T-001': 20, 'T-002': 10}})],
      /un-sells/
    )
    rejects([one, two, at3({packs: 16})], /size of the edition/)
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
      remaining: {'T-001': 18, 'T-002': 10}
    })
    expect(verifySupplyPage([one, two, idle], EXPECT).latest.seq).toBe(3)
  })
})

describe('stillGoingForward', () => {
  const at = (sold: number, remaining: Record<string, number>) => ({
    packs: PACKS,
    issuedPerPack: 2,
    sold,
    remaining
  })

  it('lets figures stand still or move forward', () => {
    const before = at(1, {'T-001': 18, 'T-002': 10})
    expect(() => stillGoingForward(before, before)).not.toThrow()
    expect(() =>
      stillGoingForward(before, at(3, {'T-001': 14, 'T-002': 10}))
    ).not.toThrow()
  })

  it('catches a gap that went the wrong way', () => {
    const before = at(2, {'T-001': 16, 'T-002': 10})
    expect(() =>
      stillGoingForward(before, at(1, {'T-001': 18, 'T-002': 10}))
    ).toThrow(/un-sells/)
    expect(() =>
      stillGoingForward(before, at(2, {'T-001': 17, 'T-002': 9}))
    ).toThrow(/grows the stock of T-001/)
    expect(() => stillGoingForward(before, at(2, {'T-002': 10}))).toThrow(
      /stops counting T-001/
    )
    expect(() =>
      stillGoingForward(before, {
        ...at(2, {'T-001': 16, 'T-002': 10}),
        packs: 7
      })
    ).toThrow(/size of the edition/)
  })
})

describe('loadSupply', () => {
  const edition = {id: 'six-t', mint: 'https://mint.example/t'}
  const key = supplyWitnessKeyFor(edition)
  const PAGE = 3

  const memory = (seed?: unknown) => {
    const store = new Map<string, string>()
    if (seed !== undefined) store.set(key, JSON.stringify(seed))
    return {
      store,
      witness: () => JSON.parse(store.get(key)!) as SupplyWitness,
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, value: string) => {
        store.set(k, value)
      }
    }
  }

  /* A mint that serves `PAGE` snapshots at a time out of `events`, the way
     the real one does: newest without `from`, and from a sequence number
     with it. Records every URL so the request count can be asserted. */
  const serving = (
    events: NostrEvent[],
    over: Record<string, unknown> = {}
  ) => {
    const calls: string[] = []
    const fetcher = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      const raw = url.searchParams.get('from')
      const total = events.length
      const start = raw ? Number(raw) : Math.max(1, total - PAGE + 1)
      const window = events.slice(start - 1, start - 1 + PAGE)
      return {
        ok: true,
        json: async () => ({
          fault: null,
          total,
          page_size: PAGE,
          first_seq: window.length ? start : 0,
          last_seq: window.length ? start + window.length - 1 : 0,
          events: window,
          ...over
        })
      } as Response
    }) as typeof fetch
    return {fetcher, calls}
  }

  const witnessFor = (event: NostrEvent, over: Partial<SupplyWitness> = {}) => {
    const c = JSON.parse(event.content)
    return {
      seq: c.seq,
      id: event.id,
      censusSha256: CENSUS,
      packs: c.packs,
      issuedPerPack: c.issued_per_pack,
      sold: c.sold,
      remaining: c.remaining,
      ...over
    }
  }

  it('reads the newest page and remembers its head', async () => {
    const events = chainOf(8)
    const storage = memory()
    const {fetcher, calls} = serving(events)
    const chain = await loadSupply({
      fetch: fetcher,
      storage,
      edition,
      expect: EXPECT
    })
    expect(calls).toEqual(['/t/nutft/supply'])
    expect(chain.total).toBe(8)
    expect(chain.oldest.seq).toBe(6)
    expect(chain.latest.seq).toBe(8)
    expect(storage.witness()).toMatchObject({
      seq: 8,
      id: events[7]!.id,
      censusSha256: CENSUS,
      sold: 7
    })
    expect(storage.witness().remaining).toEqual({'T-001': 6, 'T-002': 10})
  })

  it('checks a recent witness on the page it already has, in one request', async () => {
    const events = chainOf(8)
    const {fetcher, calls} = serving(events)
    const storage = memory(witnessFor(events[6]!))
    expect(
      (await loadSupply({fetch: fetcher, storage, edition, expect: EXPECT}))
        .latest.seq
    ).toBe(8)
    expect(calls).toEqual(['/t/nutft/supply'])
  })

  it('reaches back for an older witness in exactly one more request', async () => {
    const events = chainOf(8)
    const {fetcher, calls} = serving(events)
    const storage = memory(witnessFor(events[1]!))
    expect(
      (await loadSupply({fetch: fetcher, storage, edition, expect: EXPECT}))
        .latest.seq
    ).toBe(8)
    expect(calls).toEqual(['/t/nutft/supply', '/t/nutft/supply?from=2'])
    expect(storage.witness().seq).toBe(8)
  })

  it('catches a rewritten snapshot on the page and off it', async () => {
    const events = chainOf(8)
    const near = memory(witnessFor(events[6]!, {id: 'a'.repeat(64)}))
    await expect(
      loadSupply({
        fetch: serving(events).fetcher,
        storage: near,
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/rewritten/)
    expect(near.witness().id).toBe('a'.repeat(64))

    const far = memory(witnessFor(events[1]!, {id: 'b'.repeat(64)}))
    await expect(
      loadSupply({
        fetch: serving(events).fetcher,
        storage: far,
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/rewritten/)
    expect(far.witness().id).toBe('b'.repeat(64))
  })

  /* The reason the witness carries figures at all: without them a mint could
     move backwards across a gap larger than one page and go unnoticed. */
  it('holds the mint to the figures across a gap it cannot see', async () => {
    const events = chainOf(8)
    const storage = memory(witnessFor(events[1]!, {sold: 6}))
    await expect(
      loadSupply({
        fetch: serving(events).fetcher,
        storage,
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/un-sells/)

    const grown = memory(
      witnessFor(events[1]!, {remaining: {'T-001': 0, 'T-002': 0}})
    )
    await expect(
      loadSupply({
        fetch: serving(events).fetcher,
        storage: grown,
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/grows the stock/)
  })

  it('refuses a witness the mint says is beyond the end of its chain', async () => {
    const events = chainOf(8)
    const storage = memory(witnessFor(events[7]!, {seq: 99}))
    await expect(
      loadSupply({
        fetch: serving(events).fetcher,
        storage,
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/shorter than what this wallet saw/)
  })

  it('refuses a page that does not start where it was asked to', async () => {
    const events = chainOf(8)
    const storage = memory(witnessFor(events[1]!))
    /* A mint that ignores `from` and always serves the tail. */
    const fetcher = (async () =>
      ({
        ok: true,
        json: async () => ({
          fault: null,
          total: 8,
          events: events.slice(5)
        })
      }) as Response) as typeof fetch
    await expect(
      loadSupply({fetch: fetcher, storage, edition, expect: EXPECT})
    ).rejects.toThrow(/did not serve the supply snapshot this wallet asked for/)
  })

  it('refuses a chain that claims to be shorter than the page it served', async () => {
    const events = chainOf(8)
    await expect(
      loadSupply({
        fetch: serving(events, {total: 2}).fetcher,
        storage: memory(),
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/shorter than what it just served/)
  })

  it('reads a mint that serves the whole chain and reports no total', async () => {
    const events = chainOf(3)
    const fetcher = (async () =>
      ({
        ok: true,
        json: async () => ({fault: null, events})
      }) as Response) as typeof fetch
    const chain = await loadSupply({
      fetch: fetcher,
      storage: memory(),
      edition,
      expect: EXPECT
    })
    expect(chain.total).toBe(3)
  })

  it('passes on a fault the mint reports about its own books', async () => {
    await expect(
      loadSupply({
        fetch: serving(chainOf(3), {fault: 'packs sold went from 1 to 0'})
          .fetcher,
        storage: memory(),
        edition,
        expect: EXPECT
      })
    ).rejects.toThrow(/own books do not balance: packs sold went from 1 to 0/)
  })

  it('treats a bad answer as no answer', async () => {
    const answering = (body: unknown, ok = true) =>
      loadSupply({
        fetch: (async () =>
          ({ok, json: async () => body}) as Response) as typeof fetch,
        storage: memory(),
        edition,
        expect: EXPECT
      })
    await expect(answering({}, false)).rejects.toThrow(/did not answer/)
    await expect(answering([])).rejects.toThrow(/not readable/)
    await expect(answering({events: 'no'})).rejects.toThrow(/no supply record/)
  })

  it('discards a witness it cannot read or that is about another census', async () => {
    const events = chainOf(8)
    const unreadable = memory()
    unreadable.store.set(key, '{"seq":"two"}')
    expect(
      (
        await loadSupply({
          fetch: serving(events).fetcher,
          storage: unreadable,
          edition,
          expect: EXPECT
        })
      ).latest.seq
    ).toBe(8)

    /* An id that would be a rewrite if it were compared at all. */
    const foreign = memory(
      witnessFor(events[6]!, {id: 'a'.repeat(64), censusSha256: 'd'.repeat(64)})
    )
    expect(
      (
        await loadSupply({
          fetch: serving(events).fetcher,
          storage: foreign,
          edition,
          expect: EXPECT
        })
      ).latest.seq
    ).toBe(8)
    expect(foreign.witness().censusSha256).toBe(CENSUS)
  })
})

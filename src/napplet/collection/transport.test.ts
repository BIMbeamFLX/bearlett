import {describe, expect, it, vi} from 'vitest'
import {
  ATTEMPTS,
  LONGEST_WAIT_MS,
  createCollectionFetch,
  routeRequest
} from './transport'
import type {NutftRequest, NutftResponse} from '../../host/nutft-contract'

const MINT = 'https://tcg.example/g'
const MIRRORS = ['https://blossom.primal.net', 'https://nostr.download']
const where = {mint: MINT, mirrors: MIRRORS}
const SHA = 'a'.repeat(64)

describe('routeRequest', () => {
  it('maps the mint paths the card wallet actually calls', () => {
    expect(routeRequest(`${MINT}/v1/info`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'info'
    })
    expect(routeRequest(`${MINT}/v1/keysets`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'keysets'
    })
    expect(routeRequest(`${MINT}/nutft/catalog`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'catalog'
    })
    expect(routeRequest(`${MINT}/blossom/${SHA}`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'blob',
      parameter: SHA
    })
    expect(
      routeRequest(`${MINT}/nutft/reveal?payment_hash=abc`, 'GET', where)
    ).toEqual({kind: 'operation', operation: 'reveal', parameter: 'abc'})
    expect(routeRequest(`${MINT}/nutft/quote`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'quote'
    })
    expect(routeRequest(`${MINT}/nutft/supply`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'supply'
    })
    /* The chain is paged, so a wallet reaching back to a snapshot it
       remembers must be able to name where to start. */
    expect(routeRequest(`${MINT}/nutft/supply?from=42`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'supply',
      parameter: '42'
    })
    expect(
      routeRequest(`${MINT}/nutft/quote?deck=blackout`, 'GET', where)
    ).toEqual({kind: 'operation', operation: 'quote', parameter: 'blackout'})
    for (const [path, operation] of [
      ['/v1/checkstate', 'checkstate'],
      ['/v1/restore', 'restore'],
      ['/nutft/purchase', 'purchase'],
      ['/nutft/booster', 'booster'],
      ['/nutft/trade', 'trade'],
      ['/nutft/possession', 'possession']
    ] as const)
      expect(routeRequest(MINT + path, 'POST', where)).toEqual({
        kind: 'operation',
        operation
      })
  })

  it('does not confuse /v1/keys with /v1/keysets', () => {
    expect(routeRequest(`${MINT}/v1/keys`, 'GET', where)).toEqual({
      kind: 'operation',
      operation: 'keys'
    })
  })

  it('sends an allowed mirror to the byte channel', () => {
    expect(
      routeRequest(`https://blossom.primal.net/${SHA}.webp`, 'GET', where)
    ).toEqual({kind: 'mirror', url: `https://blossom.primal.net/${SHA}.webp`})
  })

  it('refuses an address that is neither the mint nor a mirror', () => {
    expect(() =>
      routeRequest('https://evil.example/steal', 'GET', where)
    ).toThrow(/not the mint or an approved mirror/)
    /* A neighbouring path on the mint's own origin is not this mint. */
    expect(() =>
      routeRequest('https://tcg.example/v1/info', 'GET', where)
    ).toThrow(/not the mint or an approved mirror/)
  })

  it('refuses a POST anywhere but the mint', () => {
    expect(() =>
      routeRequest(`https://blossom.primal.net/${SHA}`, 'POST', where)
    ).toThrow(/Only the mint/)
  })

  it('refuses a mint path it has no operation for', () => {
    expect(() => routeRequest(`${MINT}/v1/melt/bolt11`, 'POST', where)).toThrow(
      /no POST operation/
    )
    expect(() => routeRequest(`${MINT}/nutft/trade`, 'GET', where)).toThrow(
      /no GET operation/
    )
  })

  it('refuses a query the operation does not publish', () => {
    expect(() =>
      routeRequest(`${MINT}/nutft/quote?_cachebust=1`, 'GET', where)
    ).toThrow(/takes no/)
    expect(() =>
      routeRequest(`${MINT}/nutft/catalog?x=1`, 'GET', where)
    ).toThrow(/takes no/)
  })

  it('refuses a blob parameter that tries to climb the path', () => {
    expect(() =>
      routeRequest(`${MINT}/blossom/${SHA}/extra`, 'GET', where)
    ).toThrow()
  })
})

describe('createCollectionFetch', () => {
  const host = (reply: NutftResponse = {status: 200, body: '{"ok":true}'}) => {
    const calls: NutftRequest[] = []
    return {
      calls,
      request: vi.fn(async (request: NutftRequest) => {
        calls.push(request)
        return reply
      })
    }
  }

  it('returns the mint reply as a response', async () => {
    const nutft = host({status: 201, body: '{"pack_id":"pack-0001"}'})
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft,
      resource: {bytes: vi.fn()},
      mirrors: MIRRORS
    })
    const response = await fetcher(`${MINT}/nutft/booster`, {
      method: 'POST',
      body: '{"idempotency_key":"k"}'
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({pack_id: 'pack-0001'})
    expect(nutft.calls[0]).toEqual({
      mint: MINT,
      operation: 'booster',
      body: '{"idempotency_key":"k"}'
    })
  })

  it('serialises capability calls, because the host allows one at a time', async () => {
    let inFlight = 0
    let peak = 0
    const nutft = {
      request: vi.fn(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
        return {status: 200, body: '{}'}
      })
    }
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft,
      resource: {bytes: vi.fn()},
      mirrors: MIRRORS
    })
    /* Exactly what getKeyset does: both halves at once. */
    await Promise.all([fetcher(`${MINT}/v1/info`), fetcher(`${MINT}/v1/keys`)])
    expect(nutft.request).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
  })

  it('keeps the queue moving after a failed call', async () => {
    let call = 0
    const nutft = {
      request: vi.fn(async () => {
        call += 1
        if (call === 1) throw new Error('the mint refused')
        return {status: 200, body: '{"second":true}'}
      })
    }
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft,
      resource: {bytes: vi.fn()},
      mirrors: MIRRORS
    })
    /* A trade is never asked twice, so its failure reaches the caller. */
    await expect(
      fetcher(`${MINT}/nutft/trade`, {method: 'POST', body: '{}'})
    ).rejects.toThrow(/refused/)
    expect(await (await fetcher(`${MINT}/v1/keys`)).json()).toEqual({
      second: true
    })
  })

  it('fetches a mirror through the byte channel and caps its size', async () => {
    const bytes = vi.fn(async () => new Blob(['face']))
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft: host(),
      resource: {bytes},
      mirrors: MIRRORS
    })
    const url = `https://nostr.download/${SHA}.webp`
    expect(await (await fetcher(url)).text()).toBe('face')
    expect(bytes).toHaveBeenCalledWith(url, {signal: undefined})

    const big = createCollectionFetch({
      mint: MINT,
      nutft: host(),
      resource: {bytes: async () => new Blob(['x'.repeat(64)])},
      mirrors: MIRRORS,
      maxBytes: 16
    })
    await expect(big(url)).rejects.toThrow(/larger than this wallet accepts/)
  })

  it('names each mint operation to an observer, and nothing more', async () => {
    const seen: unknown[][] = []
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft: host(),
      resource: {bytes: vi.fn(async () => new Blob(['face']))},
      mirrors: MIRRORS,
      observe: (...args: unknown[]) => {
        seen.push(args)
        throw new Error('an observer that fails')
      }
    })
    await fetcher(`${MINT}/v1/restore`, {
      method: 'POST',
      body: '{"outputs":[]}'
    })
    await fetcher(`${MINT}/nutft/reveal?payment_hash=abc`)
    await fetcher(`https://nostr.download/${SHA}.webp`)
    /* A mirror fetch is not a mint operation, and a failing observer does not
       stop the call it was told about. */
    expect(seen).toEqual([['restore'], ['reveal']])
  })

  describe('when the mint is busy', () => {
    /* A host whose replies are scripted, one per call, and a clock that adds
       up the waits instead of waiting. */
    const scripted = (replies: Array<NutftResponse | Error>) => {
      const calls: NutftRequest[] = []
      return {
        calls,
        request: vi.fn(async (request: NutftRequest) => {
          calls.push(request)
          const next = replies.shift() ?? {status: 200, body: '{"ok":true}'}
          if (next instanceof Error) throw next
          return next
        })
      }
    }
    const fetcherFor = (
      nutft: ReturnType<typeof scripted>,
      waits: number[] = [],
      seen: unknown[][] = []
    ) =>
      createCollectionFetch({
        mint: MINT,
        nutft,
        resource: {bytes: vi.fn()},
        mirrors: MIRRORS,
        sleep: async ms => {
          waits.push(ms)
        },
        observe: (...args: unknown[]) => {
          seen.push(args)
        }
      })

    it('asks a read again after the wait the mint names', async () => {
      const nutft = scripted([
        {status: 429, body: '{"error":"rate limited"}', retryAfterMs: 1500},
        {status: 503, body: '{"error":"busy"}'},
        {status: 200, body: '{"states":[]}'}
      ])
      const waits: number[] = []
      const seen: unknown[][] = []
      const reply = await fetcherFor(nutft, waits, seen)(`${MINT}/v1/keys`)
      expect(reply.status).toBe(200)
      expect(nutft.calls).toHaveLength(3)
      /* The mint's own wait first, then the backoff for the second try. */
      expect(waits).toEqual([1500, 1000])
      expect(seen).toEqual([
        ['keys'],
        ['keys', {retryInMs: 1500}],
        ['keys', {retryInMs: 1000}]
      ])
    })

    it('leaves restore and checkstate to the library, with the wait the mint named', async () => {
      for (const [path, body] of [
        ['/v1/restore', '{"outputs":[]}'],
        ['/v1/checkstate', '{"Ys":[]}']
      ]) {
        const nutft = scripted([
          {status: 429, body: '{"error":"rate limited"}', retryAfterMs: 1500},
          new Error('never reached')
        ])
        const waits: number[] = []
        const reply = await fetcherFor(nutft, waits)(`${MINT}${path}`, {
          method: 'POST',
          body
        })
        /* Handed on at once, asked once: the library waits, and only it. */
        expect(reply.status).toBe(429)
        expect(reply.headers.get('retry-after')).toBe('2')
        expect(nutft.calls).toHaveLength(1)
        expect(waits).toEqual([])

        const lost = scripted([new Error('Shell request timed out.')])
        await expect(
          fetcherFor(lost)(`${MINT}${path}`, {method: 'POST', body})
        ).rejects.toThrow(/timed out/)
        expect(lost.calls).toHaveLength(1)
      }
    })

    it('asks again when the shell could not deliver, then gives up with its error', async () => {
      const lost = () => new Error('Shell request timed out.')
      const nutft = scripted([lost(), lost(), lost(), lost(), lost()])
      const waits: number[] = []
      await expect(
        fetcherFor(nutft, waits)(`${MINT}/nutft/catalog`)
      ).rejects.toThrow(/timed out/)
      expect(nutft.calls).toHaveLength(ATTEMPTS)
      expect(waits).toEqual([500, 1000, 2000])
    })

    it('hands the last busy answer on after the last try', async () => {
      const busy = {status: 429, body: '{"error":"rate limited"}'}
      const nutft = scripted([busy, busy, busy, busy, busy])
      const reply = await fetcherFor(nutft)(`${MINT}/v1/keys`)
      expect(reply.status).toBe(429)
      expect(nutft.calls).toHaveLength(ATTEMPTS)
    })

    it('never waits longer than it allows, whatever the mint asks', async () => {
      const nutft = scripted([
        {status: 429, body: '{}', retryAfterMs: 3_600_000},
        {status: 200, body: '{}'}
      ])
      const waits: number[] = []
      await fetcherFor(nutft, waits)(`${MINT}/v1/info`)
      expect(waits).toEqual([LONGEST_WAIT_MS])
    })

    it('never sends a trade again: the card library keeps its pending outputs', async () => {
      const nutft = scripted([
        {status: 429, body: '{"error":"rate limited"}', retryAfterMs: 10},
        new Error('never reached')
      ])
      const waits: number[] = []
      const reply = await fetcherFor(nutft, waits)(`${MINT}/nutft/trade`, {
        method: 'POST',
        body: '{"idempotency_key":"k","inputs":[],"outputs":[]}'
      })
      expect(reply.status).toBe(429)
      expect(nutft.calls).toHaveLength(1)
      expect(waits).toEqual([])
      const failing = scripted([new Error('Shell request timed out.')])
      await expect(
        fetcherFor(failing)(`${MINT}/nutft/trade`, {
          method: 'POST',
          body: '{"idempotency_key":"k","inputs":[],"outputs":[]}'
        })
      ).rejects.toThrow(/timed out/)
      expect(failing.calls).toHaveLength(1)
    })
  })

  it('never lets an unknown address reach either channel', async () => {
    const nutft = host()
    const bytes = vi.fn()
    const fetcher = createCollectionFetch({
      mint: MINT,
      nutft,
      resource: {bytes},
      mirrors: MIRRORS
    })
    await expect(fetcher('https://evil.example/x')).rejects.toThrow()
    expect(nutft.request).not.toHaveBeenCalled()
    expect(bytes).not.toHaveBeenCalled()
  })
})

import {describe, expect, it, vi} from 'vitest'
import {createCollectionFetch, routeRequest} from './transport'
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
    await expect(fetcher(`${MINT}/v1/info`)).rejects.toThrow(/refused/)
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

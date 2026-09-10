import {describe, expect, it, vi} from 'vitest'
import {createNutftService, nutftEndpoint} from './nutft-service'
import {nutftMintUrl} from './nutft-contract'

const MINT = 'https://tcg.example/g'

describe('nutftEndpoint', () => {
  it('maps each operation onto one fixed endpoint', () => {
    expect(nutftEndpoint({mint: MINT, operation: 'info'})).toEqual({
      url: 'https://tcg.example/g/v1/info',
      method: 'GET'
    })
    expect(nutftEndpoint({mint: MINT, operation: 'catalog'})).toEqual({
      url: 'https://tcg.example/g/nutft/catalog',
      method: 'GET'
    })
    expect(nutftEndpoint({mint: MINT, operation: 'supply'})).toEqual({
      url: 'https://tcg.example/g/nutft/supply',
      method: 'GET'
    })
    /* The supply chain is served a page at a time; a wallet reaching back
       to a snapshot it remembers has to be able to say where to start. */
    expect(
      nutftEndpoint({mint: MINT, operation: 'supply', parameter: '42'})
    ).toEqual({
      url: 'https://tcg.example/g/nutft/supply?from=42',
      method: 'GET'
    })
    expect(
      nutftEndpoint({mint: MINT, operation: 'blob', parameter: 'a'.repeat(64)})
    ).toEqual({
      url: `https://tcg.example/g/blossom/${'a'.repeat(64)}`,
      method: 'GET'
    })
    expect(
      nutftEndpoint({mint: MINT, operation: 'reveal', parameter: 'hash-1'})
    ).toEqual({
      url: 'https://tcg.example/g/nutft/reveal?payment_hash=hash-1',
      method: 'GET'
    })
    expect(
      nutftEndpoint({
        mint: MINT,
        operation: 'trade',
        body: JSON.stringify({idempotency_key: 'k', inputs: [], outputs: []})
      })
    ).toEqual({url: 'https://tcg.example/g/nutft/trade', method: 'POST'})
  })

  it('keeps the mint path, because an edition is identified by it', () => {
    expect(nutftMintUrl('https://tcg.example/g/')).toBe('https://tcg.example/g')
    expect(
      nutftEndpoint({mint: 'https://tcg.example', operation: 'keys'}).url
    ).toBe('https://tcg.example/v1/keys')
  })

  it('refuses a mint that carries its own arguments or credentials', () => {
    for (const mint of [
      'https://user:pw@tcg.example',
      'https://tcg.example/?a=1',
      'https://tcg.example/#x',
      'ftp://tcg.example'
    ])
      expect(() => nutftEndpoint({mint, operation: 'info'})).toThrow()
  })

  it('allows loopback so the preview host can serve a test mint', () => {
    expect(nutftMintUrl('http://127.0.0.1:4190/g')).toBe(
      'http://127.0.0.1:4190/g'
    )
    expect(() => nutftMintUrl('http://tcg.example')).toThrow()
  })

  it('refuses an operation it does not know', () => {
    expect(() =>
      nutftEndpoint({mint: MINT, operation: 'melt' as never})
    ).toThrow(/Invalid operation/)
  })

  it('refuses a parameter where the operation takes none', () => {
    expect(() =>
      nutftEndpoint({mint: MINT, operation: 'info', parameter: 'x'})
    ).toThrow(/takes no parameter/)
    expect(() =>
      nutftEndpoint({
        mint: MINT,
        operation: 'trade',
        parameter: 'x',
        body: '{"inputs":[]}'
      })
    ).toThrow(/takes no parameter/)
  })

  it('refuses a parameter that is not a plain token', () => {
    for (const parameter of ['../secret', 'a/b', 'a?b', 'x'.repeat(201), ''])
      expect(() =>
        nutftEndpoint({mint: MINT, operation: 'blob', parameter})
      ).toThrow(/parameter/)
  })

  it('refuses a body field the operation does not declare', () => {
    expect(() =>
      nutftEndpoint({
        mint: MINT,
        operation: 'trade',
        body: JSON.stringify({idempotency_key: 'k', inputs: [], evil: 1})
      })
    ).toThrow(/Unsupported request field/)
  })

  it('refuses a body that is not one JSON object, and a GET that carries one', () => {
    for (const body of ['[]', 'null', 'not json', '"text"'])
      expect(() =>
        nutftEndpoint({mint: MINT, operation: 'checkstate', body})
      ).toThrow(/Invalid request body/)
    expect(() =>
      nutftEndpoint({mint: MINT, operation: 'catalog', body: '{}'})
    ).toThrow(/GET cannot carry a body/)
  })

  it('bounds the number of items in a batch', () => {
    const outputs = Array.from({length: 257}, () => ({amount: 1}))
    expect(() =>
      nutftEndpoint({
        mint: MINT,
        operation: 'booster',
        body: JSON.stringify({idempotency_key: 'k', outputs})
      })
    ).toThrow(/too many items/)
  })
})

describe('createNutftService', () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {status: 200})

  /* One collection is one storage scope, whatever window it is shown in. That
     is the whole point of the lease, so the fixture must not hand each window
     its own scope. */
  const service = (
    over: Partial<Parameters<typeof createNutftService>[0]> = {}
  ) =>
    createNutftService({
      scope: () => 'scope:600b-e1',
      allowed: () => true,
      fetch: vi.fn(async () => ok({ok: true})) as unknown as typeof fetch,
      ...over
    })

  it('fetches with no credentials, no redirect and no referrer', async () => {
    const inner = vi.fn(async () => ok({name: 'mint'}))
    const nutft = service({fetch: inner as unknown as typeof fetch})
    const reply = await nutft.request('win-1', {mint: MINT, operation: 'info'})
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.body)).toEqual({name: 'mint'})
    const [url, init] = inner.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://tcg.example/g/v1/info')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.cache).toBe('no-store')
    expect(init.headers).not.toHaveProperty('Authorization')
  })

  it('refuses a mint the host has not approved', async () => {
    const nutft = service({allowed: () => false})
    await expect(
      nutft.request('win-1', {mint: MINT, operation: 'info'})
    ).rejects.toThrow(/not approved/)
  })

  it('keeps one collection to one window', async () => {
    const nutft = service()
    await nutft.request('win-1', {mint: MINT, operation: 'info'})
    await expect(
      nutft.request('win-2', {mint: MINT, operation: 'info'})
    ).rejects.toThrow(/already open in another window/)
    nutft.onWindowDestroyed('win-1')
    await expect(
      nutft.request('win-2', {mint: MINT, operation: 'info'})
    ).resolves.toBeTruthy()
  })

  it('permits one request at a time per window', async () => {
    let release: (value: Response) => void = () => {}
    const slow = vi.fn(
      () => new Promise<Response>(resolve => (release = resolve))
    )
    const nutft = service({fetch: slow as unknown as typeof fetch})
    const first = nutft.request('win-1', {mint: MINT, operation: 'info'})
    await expect(
      nutft.request('win-1', {mint: MINT, operation: 'keys'})
    ).rejects.toThrow(/already running/)
    release(ok({}))
    await expect(first).resolves.toBeTruthy()
  })

  it('stops a response that exceeds the size limit', async () => {
    const huge = new Uint8Array(3 * 1024 * 1024)
    const nutft = service({
      fetch: (async () => new Response(huge)) as unknown as typeof fetch
    })
    await expect(
      nutft.request('win-1', {mint: MINT, operation: 'catalog'})
    ).rejects.toThrow(/size limit/)
  })

  it('redacts the reason a request failed, but names a busy window', async () => {
    const sent: Array<Record<string, unknown>> = []
    const nutft = service({allowed: () => false})
    nutft.handleMessage(
      'win-1',
      {
        type: 'nutft.request',
        id: '1',
        request: {mint: MINT, operation: 'info'}
      },
      message => sent.push(message as Record<string, unknown>)
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].ok).toBe(false)
    expect(String(sent[0].error)).not.toContain('tcg.example')
    expect(String(sent[0].error)).toMatch(/Check the stored operation/)

    const busy: Array<Record<string, unknown>> = []
    const shared = service()
    await shared.request('win-1', {mint: MINT, operation: 'info'})
    shared.handleMessage('win-2', {type: 'nutft.acquire', id: '2'}, message =>
      busy.push(message as Record<string, unknown>)
    )
    await vi.waitFor(() => expect(busy).toHaveLength(1))
    expect(String(busy[0].error)).toMatch(/already open in another window/)
  })

  it('ignores a message that is not its own', () => {
    const sent: unknown[] = []
    const nutft = service()
    nutft.handleMessage('win-1', {type: 'cashu.request', id: '1'}, m =>
      sent.push(m)
    )
    nutft.handleMessage('win-1', {type: 'nutft.request'}, m => sent.push(m))
    expect(sent).toHaveLength(0)
  })
})

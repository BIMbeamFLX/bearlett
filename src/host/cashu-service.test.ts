import {describe, expect, it, vi} from 'vitest'
import {cashuEndpoint, createCashuService} from './cashu-service'
import type {CashuRequest} from '../napplet/cashu/transport'

const request: CashuRequest = {
  mint: 'https://mint.example/base',
  operation: 'info'
}
describe('Cashu host capability', () => {
  it('maps only approved endpoints and omits credentials, redirects and caches', async () => {
    const fetch = vi.fn(
      async () => new Response('{}', {headers: {'Retry-After': '2'}})
    )
    const host = createCashuService({
      scope: () => 'wallet',
      allowed: () => true,
      fetch
    })
    expect(await host.request('a', request)).toEqual({
      status: 200,
      body: '{}',
      retryAfterMs: 2000
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://mint.example/base/v1/info',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      })
    )
  })
  it('denies unapproved mints and simultaneous writers before network access', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    const host = createCashuService({
      scope: () => 'wallet',
      allowed: id => id === 'a',
      fetch
    })
    await host.request('a', request)
    await expect(host.request('b', request)).rejects.toThrow('another window')
    host.onWindowDestroyed('a')
    await expect(host.request('b', request)).rejects.toThrow('not approved')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    'http://mint.example',
    'https://user:secret@mint.example',
    'https://mint.example/?token=secret',
    'https://mint.example/#secret'
  ])('rejects unsafe mint %s', mint => {
    expect(() => cashuEndpoint({...request, mint})).toThrow()
  })
  it('rejects path traversal, arbitrary operations and unsupported POST fields', () => {
    expect(() =>
      cashuEndpoint({...request, operation: 'keys', parameter: '../info'})
    ).toThrow()
    expect(() =>
      cashuEndpoint({...request, operation: 'constructor' as never})
    ).toThrow()
    expect(() =>
      cashuEndpoint({
        ...request,
        operation: 'mintQuote',
        body: JSON.stringify({amount: 1, unit: 'usd'})
      })
    ).toThrow()
    expect(() =>
      cashuEndpoint({
        ...request,
        operation: 'swap',
        body: JSON.stringify({
          inputs: [],
          outputs: [],
          url: 'https://evil.test'
        })
      })
    ).toThrow()
  })
  it('redacts bearer contents in error replies', async () => {
    const host = createCashuService({
      scope: () => 'wallet',
      allowed: () => true,
      fetch: async () => {
        throw new Error('secret bearer payload')
      }
    })
    const reply = await new Promise(resolve =>
      host.handleMessage(
        'a',
        {type: 'cashu.request', id: 'id', request},
        resolve
      )
    )
    expect(reply).toMatchObject({
      type: 'cashu.request.result',
      id: 'id',
      ok: false
    })
    expect(JSON.stringify(reply)).not.toContain('secret bearer payload')
  })
})

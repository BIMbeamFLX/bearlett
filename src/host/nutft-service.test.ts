import {describe, expect, it, vi} from 'vitest'
import {createNutftService, nutftEndpoint} from './nutft-service'
import type {NutftServiceOptions} from './nutft-service'
import {UNSAFE_OPEN_MESSAGE, nutftMintUrl} from './nutft-contract'

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
     its own scope. Node has Web Locks of its own, shared by every test in the
     file, so each service here gets the locks its test gives it, or none. */
  const service = (
    over: Partial<Parameters<typeof createNutftService>[0]> = {}
  ) =>
    createNutftService({
      scope: () => 'scope:600b-e1',
      allowed: () => true,
      fetch: vi.fn(async () => ok({ok: true})) as unknown as typeof fetch,
      locks: null,
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

  /* Web Locks as a browser shares them between the tabs of one origin. */
  const sharedLocks = () => {
    const held = new Set<string>()
    const manager = {
      held,
      request: (async (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => unknown
      ) => {
        if (held.has(name)) {
          expect(options.ifAvailable).toBe(true)
          return callback(null)
        }
        held.add(name)
        try {
          return await callback({name, mode: 'exclusive'} as Lock)
        } finally {
          held.delete(name)
        }
      }) as unknown as LockManager['request']
    }
    return manager
  }

  it('holds a lease across the tabs of the shell with a Web Lock', async () => {
    const locks = sharedLocks()
    const tab1 = service({locks})
    const tab2 = service({locks})
    await tab1.acquire('win-1')
    expect([...locks.held]).toEqual(['bearlett:nutft-lease:scope:600b-e1'])
    await expect(tab2.acquire('win-2')).rejects.toThrow(
      /already open in another window/
    )
    await expect(
      tab2.request('win-2', {mint: MINT, operation: 'info'})
    ).rejects.toThrow(/already open in another window/)

    /* Closing the first window gives the lock back to the other tab. */
    tab1.onWindowDestroyed('win-1')
    await vi.waitFor(() => expect(locks.held.size).toBe(0))
    await expect(tab2.acquire('win-2')).resolves.toBeUndefined()
    await expect(tab1.acquire('win-3')).rejects.toThrow(
      /already open in another window/
    )
  })

  it('gives the lock back when the seed is refused', async () => {
    const locks = sharedLocks()
    const tab1 = service({locks, seed: () => 'not a seed'})
    const tab2 = service({locks})
    await expect(tab1.acquire('win-1')).rejects.toThrow()
    await vi.waitFor(() => expect(locks.held.size).toBe(0))
    await expect(tab2.acquire('win-2')).resolves.toBeUndefined()
  })

  it('gives back a lock that arrives after its window closed', async () => {
    const locks = sharedLocks()
    let asked = 0
    let grant: () => void = () => {}
    const slow = {
      request: ((
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => unknown
      ) => {
        asked += 1
        return new Promise<void>(resolve => (grant = resolve)).then(() =>
          (
            locks.request as unknown as (
              name: string,
              options: LockOptions,
              callback: (lock: Lock | null) => unknown
            ) => Promise<unknown>
          )(name, options, callback)
        )
      }) as unknown as LockManager['request']
    }
    const tab = service({locks: slow})
    const late = tab.acquire('win-1')
    await vi.waitFor(() => expect(asked).toBe(1))
    tab.onWindowDestroyed('win-1')
    grant()
    await expect(late).rejects.toThrow()
    await vi.waitFor(() => expect(locks.held.size).toBe(0))

    /* And a window that claims the scope while the grant is on its way gets
       that grant instead of waiting for a second one. */
    const first = tab.acquire('win-2')
    await vi.waitFor(() => expect(asked).toBe(2))
    tab.onWindowDestroyed('win-2')
    const second = tab.acquire('win-3')
    grant()
    await expect(first).rejects.toThrow()
    await expect(second).resolves.toBeUndefined()
    expect(asked).toBe(2)
    expect([...locks.held]).toEqual(['bearlett:nutft-lease:scope:600b-e1'])
  })

  it('reopens in the same tab right after a window closed', async () => {
    const locks = sharedLocks()
    const tab = service({locks})
    await tab.acquire('win-1')
    tab.onWindowDestroyed('win-1')
    await expect(tab.acquire('win-2')).resolves.toBeUndefined()
  })

  it('takes the host Web Locks when none are given', async () => {
    /* The host's own navigator, whatever Web Locks this Node has or lacks. */
    const locks = sharedLocks()
    vi.stubGlobal('navigator', {locks})
    try {
      const tab = createNutftService({
        scope: () => 'scope:600b-e1',
        allowed: () => true
      })
      await tab.acquire('win-1')
      expect([...locks.held]).toEqual(['bearlett:nutft-lease:scope:600b-e1'])
      tab.onWindowDestroyed('win-1')
      await vi.waitFor(() => expect(locks.held.size).toBe(0))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('holds leases in the service alone where there are no Web Locks', async () => {
    const tab = service({locks: null})
    await tab.acquire('win-1')
    await expect(tab.acquire('win-2')).rejects.toThrow(
      /already open in another window/
    )
  })

  it('refuses a lease when the Web Lock cannot be asked for', async () => {
    const tab = service({
      locks: {
        request: (async () => {
          throw new DOMException('denied', 'SecurityError')
        }) as unknown as LockManager['request']
      }
    })
    const sent: Array<Record<string, unknown>> = []
    tab.handleMessage('win-1', {type: 'nutft.acquire', id: '1'}, message =>
      sent.push(message as Record<string, unknown>)
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].ok).toBe(false)
    await expect(
      tab.request('win-1', {mint: MINT, operation: 'info'})
    ).rejects.toThrow()
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

describe('the account seed in the acquire result', () => {
  const SEED = '7f3a'.repeat(16)
  const service = (seed: NutftServiceOptions['seed']) =>
    createNutftService({
      scope: () => 'scope:600b-e1',
      allowed: () => true,
      fetch: vi.fn(
        async () => new Response('{}', {status: 200})
      ) as unknown as typeof fetch,
      locks: null,
      seed
    })

  /* What the napplet actually receives: the reply to its message. */
  const acquire = async (
    nutft: ReturnType<typeof createNutftService>,
    windowId = 'win-1'
  ) => {
    const sent: Array<Record<string, unknown>> = []
    nutft.handleMessage(windowId, {type: 'nutft.acquire', id: 'lease'}, m =>
      sent.push(m as Record<string, unknown>)
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    return sent[0]
  }

  /* Every console method, so a value that reaches any of them is caught. */
  const watchConsole = () => {
    const spies = (
      ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const
    ).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    return {
      calls: () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0),
      restore: () => spies.forEach(spy => spy.mockRestore())
    }
  }

  it('hands a valid seed to the window that holds the lease', async () => {
    const hook = vi.fn(async () => SEED)
    const reply = await acquire(service(hook))
    expect(reply).toEqual({
      type: 'nutft.acquire.result',
      id: 'lease',
      ok: true,
      result: {seed: SEED}
    })
    expect(hook).toHaveBeenCalledWith('win-1', 'scope:600b-e1')
  })

  it('keeps the result it always had when there is no seed', async () => {
    expect((await acquire(service(undefined))).result).toBeUndefined()
    const reply = await acquire(service(() => undefined))
    expect(reply.ok).toBe(true)
    expect(reply.result).toBeUndefined()
  })

  it('never asks for the seed of a window that cannot take the lease', async () => {
    const hook = vi.fn(() => SEED)
    const nutft = service(hook)
    await acquire(nutft, 'win-1')
    const busy = await acquire(nutft, 'win-2')
    expect(busy.ok).toBe(false)
    expect(busy.error).toMatch(/already open in another window/)
    expect(JSON.stringify(busy)).not.toContain(SEED)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith('win-1', 'scope:600b-e1')
  })

  it('never puts the seed into a mint reply', async () => {
    const nutft = service(() => SEED)
    await acquire(nutft)
    const reply = await nutft.request('win-1', {mint: MINT, operation: 'info'})
    expect(JSON.stringify(reply)).not.toContain(SEED)
  })

  const refused: Array<[string, () => unknown]> = [
    ['an empty string', () => ''],
    ['63 characters', () => SEED.slice(1)],
    ['65 characters', () => SEED + 'a'],
    ['uppercase hex', () => SEED.toUpperCase()],
    ['mixed-case hex', () => 'Ab'.repeat(32)],
    ['non-hex characters', () => 'zq'.repeat(32)],
    ['a trailing newline', () => SEED + '\n'],
    ['surrounding spaces', () => ` ${SEED} `],
    ['a mnemonic', () => 'abandon '.repeat(23) + 'art'],
    ['null', () => null],
    ['a number', () => 4242424242],
    ['an object', () => ({seed: SEED})],
    [
      'a throw that names the seed',
      () => {
        throw new Error(`derivation failed for ${SEED}`)
      }
    ],
    ['a rejection', () => Promise.reject(new Error(SEED))]
  ]

  for (const [name, value] of refused)
    it(`refuses the acquire when the hook gives ${name}`, async () => {
      const seen = watchConsole()
      try {
        const nutft = service(value as NutftServiceOptions['seed'])
        const reply = await acquire(nutft)
        expect(reply.ok).toBe(false)
        expect(reply.result).toBeUndefined()
        expect(reply.error).toBe(UNSAFE_OPEN_MESSAGE)
        const text = JSON.stringify(reply)
        for (const secret of [SEED, SEED.toUpperCase(), 'zq'.repeat(32)])
          expect(text).not.toContain(secret)
        expect(text).not.toContain('abandon')
        expect(text).not.toContain('4242424242')
        expect(seen.calls()).toBe(0)

        /* The refused acquire gives the lease back, so the next window is
           not told the collection is open somewhere it is not. */
        const next = await acquire(nutft, 'win-2')
        expect(next.error).not.toMatch(/already open in another window/)
      } finally {
        seen.restore()
      }
    })

  it('refuses a seed for a window that closed while it was derived', async () => {
    let asked = false
    let finish: (value: string) => void = () => {}
    const nutft = service(() => {
      asked = true
      return new Promise<string>(resolve => (finish = resolve))
    })
    const sent: Array<Record<string, unknown>> = []
    nutft.handleMessage('win-1', {type: 'nutft.acquire', id: 'late'}, m =>
      sent.push(m as Record<string, unknown>)
    )
    await vi.waitFor(() => expect(asked).toBe(true))
    nutft.onWindowDestroyed('win-1')
    finish(SEED)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].ok).toBe(false)
    expect(JSON.stringify(sent[0])).not.toContain(SEED)
  })
})

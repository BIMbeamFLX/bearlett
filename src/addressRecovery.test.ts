import {beforeEach, describe, expect, it, vi} from 'vitest'
import {cp1FromCk1, encodeCx1} from './lnurlcash'
import type {Bearer} from './storage'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  }
})

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SERVER = 'https://mock-mint.test'
const MINT_PUBKEY = '02' + 'cd'.repeat(32)

let recovery: typeof import('./addressRecovery')
let registry: typeof import('./addressRegistry')
let cashSecrets: typeof import('./cashSecrets')
let keys: typeof import('./keys')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  recovery = await import('./addressRecovery')
  registry = await import('./addressRegistry')
  cashSecrets = await import('./cashSecrets')
  keys = await import('./keys')
  cashSecrets.setCashRoot(keys.deriveLud25CashRootNode(SEED))
})

const jsonResponse = (body: unknown) =>
  Promise.resolve({json: async () => body} as unknown as Response)

const ck1At = (index: number) =>
  cashSecrets.ck1ForSecretKey(
    cashSecrets.cashAddressSecretAtIndex(SERVER, index)!
  )

// a stand-in mint where alice@mock-mint.test auto-minted notes at the given
// branch indices, advertising `hint` as its next-unused index
const fakeMint = (liveAt: number[], hint: number | null) => {
  const live = new Map(liveAt.map(i => [cp1FromCk1(ck1At(i))!, i]))
  const branch = cashSecrets.cashAddressBranch(SERVER)!
  const requests: string[] = []
  const fetchMock = (input: string | URL) => {
    const url = new URL(input.toString())
    requests.push(url.pathname + url.search)
    if (url.pathname === '/.well-known/lnurlp/alice') {
      const metadata = [['text/plain', 'alice']]
      if (hint !== null)
        metadata.push([
          'text/xpub',
          `${encodeCx1(branch.pubkeyXOnly, branch.chainCode)}:${hint}`
        ])
      return jsonResponse({
        tag: 'payRequest',
        callback: `${SERVER}/p/alice`,
        minSendable: 1000,
        maxSendable: 100_000_000,
        metadata: JSON.stringify(metadata),
        withdrawLink: `${SERVER}/w`
      })
    }
    if (url.pathname === '/w') {
      const p = url.searchParams.get('p')
      if (p && live.has(p)) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: `${SERVER}/w/cb`,
          mintPubkey: MINT_PUBKEY,
          minWithdrawable: 21000,
          maxWithdrawable: 21000
        })
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }
    return jsonResponse({status: 'ERROR', reason: 'not found'})
  }
  return {fetchMock, requests}
}

describe('scanRegisteredAddress', () => {
  it('finds auto-minted notes as ck1 and reports the resume floor', async () => {
    const {fetchMock} = fakeMint([0, 2], null)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice')
    expect(result.error).toBeUndefined()
    expect(
      result.recovered.map(n => new URL(n.url).searchParams.get('k1'))
    ).toEqual([ck1At(0), ck1At(2)])
    expect(result.recovered[0].amount).toBe(21000)
    expect(result.highestIndex).toBe(2)
    expect(result.nextScanIndex).toBe(3)
  })

  it("lets the mint's hint raise a confirmed floor, and still re-checks below the start", async () => {
    const {fetchMock, requests} = fakeMint([1, 5], 4)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice', [], {
      startIndex: 2
    })
    // the walk starts at the hint; index 1, below both the floor and the
    // hint, is found by the window behind the start
    expect(result.checkedFrom).toBe(4)
    expect(result.serviceHint).toBe(4)
    expect(
      result.recovered.map(n => new URL(n.url).searchParams.get('k1'))
    ).toEqual([ck1At(1), ck1At(5)])
    expect(result.highestIndex).toBe(5)
    expect(result.nextScanIndex).toBe(6)
    expect(
      requests.filter(r => r.includes(`p=${cp1FromCk1(ck1At(1))}`))
    ).toHaveLength(1)
  })

  it("ignores the mint's hint on a fresh scan, the bug lnurl-wallet #188 fixed", async () => {
    // one payment reached alice: the mint already advertises index 1
    const {fetchMock} = fakeMint([0], 1)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice')
    expect(result.checkedFrom).toBe(0)
    expect(result.serviceHint).toBe(1)
    expect(
      result.recovered.map(n => new URL(n.url).searchParams.get('k1'))
    ).toEqual([ck1At(0)])
    expect(result.nextScanIndex).toBe(1)
  })

  it('finds a note that settled below the floor after an earlier pass', async () => {
    // an earlier pass found 0 and 2 while index 1 was still unpaid, so the
    // stored floor is 3; index 1 settles afterwards
    const {fetchMock} = fakeMint([0, 1, 2], 3)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const held = [0, 2].map(
      i =>
        ({url: `${SERVER}/w?k1=${ck1At(i)}&amount=21000`}) as unknown as Bearer
    )
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice', held, {
      startIndex: 3
    })
    expect(
      result.recovered.map(n => new URL(n.url).searchParams.get('k1'))
    ).toEqual([ck1At(1)])
    expect(result.nextScanIndex).toBe(3)
  })

  it('re-checks no further back than the gap limit', async () => {
    const {fetchMock, requests} = fakeMint([5, 12], null)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice', [], {
      startIndex: 30
    })
    // the window below 30 is 10..29 with the default gap limit of 20
    expect(
      result.recovered.map(n => new URL(n.url).searchParams.get('k1'))
    ).toEqual([ck1At(12)])
    expect(
      requests.filter(r => r.includes(`p=${cp1FromCk1(ck1At(5))}`))
    ).toHaveLength(0)
    expect(
      requests.filter(r => r.includes(`p=${cp1FromCk1(ck1At(10))}`))
    ).toHaveLength(1)
  })

  it('skips notes already held and reports errors with the floor intact', async () => {
    const {fetchMock} = fakeMint([0], null)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    const held = {
      url: `${SERVER}/w?k1=${ck1At(0)}&amount=21000`
    } as unknown as Bearer
    const result = await recovery.scanRegisteredAddress(SERVER, 'alice', [held])
    expect(result.recovered).toHaveLength(0)
    expect(result.nextScanIndex).toBe(1)

    cashSecrets.setCashRoot(null)
    const locked = await recovery.scanRegisteredAddress(SERVER, 'alice', [], {
      startIndex: 3
    })
    expect(locked.error).toMatch(/seed/)
    expect(locked.nextScanIndex).toBe(3)
  })
})

describe('runAddressScan', () => {
  it('claims what it finds and records where the next pass resumes', async () => {
    const {fetchMock} = fakeMint([0, 1], null)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    registry.addRegisteredAddress(SERVER, 'alice')
    const added: unknown[] = []
    const logged: string[] = []
    const result = await recovery.runAddressScan(SERVER, 'alice', [], {
      addBearer: async note => void added.push(note),
      logActivity: (_kind, message) => void logged.push(message)
    })
    expect(added).toHaveLength(2)
    expect(logged[0]).toMatch(/21 sats at alice@mock-mint.test/)
    expect(result.nextScanIndex).toBe(2)
    expect(registry.registeredAddresses()[0].nextScanIndex).toBe(2)
    expect(registry.registeredAddresses()[0].lastAutoScanAt).toBeGreaterThan(0)
  })
})

describe('checkBehindWindow', () => {
  const branchFor = () => cashSecrets.cashAddressBranch(SERVER)!

  it('waits out a rate limit on the same index instead of skipping it', async () => {
    const target = cp1FromCk1(ck1At(2))!
    let limited = true
    const seen: string[] = []
    vi.stubGlobal('fetch', ((input: string | URL) => {
      const p = new URL(input.toString()).searchParams.get('p')!
      seen.push(p)
      if (p === target && limited) {
        limited = false
        return jsonResponse({status: 'ERROR', reason: 'rate limited'})
      }
      if (p === target) {
        return jsonResponse({
          tag: 'withdrawRequest',
          callback: `${SERVER}/w/cb`,
          mintPubkey: MINT_PUBKEY,
          minWithdrawable: 21000,
          maxWithdrawable: 21000
        })
      }
      return jsonResponse({status: 'ERROR', reason: 'Unknown note.'})
    }) as unknown as typeof fetch)
    const found: number[] = []
    const results = await recovery.checkBehindWindow(
      `${SERVER}/w`,
      branchFor(),
      4,
      20,
      r => void found.push(r.index),
      0
    )
    expect(results.map(r => r.index)).toEqual([2])
    expect(found).toEqual([2])
    // 3, then 2 twice, then 1 and 0
    expect(seen.filter(p => p === target)).toHaveLength(2)
    expect(seen).toHaveLength(5)
  })

  it('stops on anything that is not an answer about the note', async () => {
    vi.stubGlobal('fetch', (() =>
      Promise.reject(new TypeError('network down'))) as unknown as typeof fetch)
    await expect(
      recovery.checkBehindWindow(`${SERVER}/w`, branchFor(), 3, 20, () => {}, 0)
    ).rejects.toThrow()
  })

  it('probes nothing at index 0', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const results = await recovery.checkBehindWindow(
      `${SERVER}/w`,
      branchFor(),
      0,
      20,
      () => {},
      0
    )
    expect(results).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

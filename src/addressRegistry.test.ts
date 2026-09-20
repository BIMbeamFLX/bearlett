import {beforeEach, describe, expect, it, vi} from 'vitest'

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

let registry: typeof import('./addressRegistry')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  registry = await import('./addressRegistry')
})

const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'

describe('registered addresses', () => {
  it('records a claim under the normalised origin and lower-cased name', () => {
    registry.addRegisteredAddress('https://Mint.Example:443/w', 'Alice')
    const all = registry.registeredAddresses()
    expect(all).toHaveLength(1)
    expect(all[0].server).toBe('https://mint.example')
    expect(all[0].username).toBe('alice')
    expect(all[0].npub).toBeUndefined()
  })

  it('is idempotent for a re-claim and updates a changed npub', () => {
    registry.addRegisteredAddress('https://mint.example', 'alice')
    registry.addRegisteredAddress('https://mint.example', 'alice')
    expect(registry.registeredAddresses()).toHaveLength(1)
    registry.addRegisteredAddress('https://mint.example', 'alice', NPUB)
    expect(registry.registeredAddresses()[0].npub).toBe(NPUB)
  })

  it('rejects a malformed username or origin', () => {
    expect(() =>
      registry.addRegisteredAddress('https://mint.example', 'not valid!')
    ).toThrow(/username/)
    expect(() =>
      registry.addRegisteredAddress('::not a url::', 'alice')
    ).toThrow()
  })

  it('persists scan bookkeeping and survives a fresh module load', async () => {
    registry.addRegisteredAddress('https://mint.example', 'alice')
    registry.markAddressScanned('https://mint.example', 'alice', 7, 1234)
    registry.setAddressAutoScan('https://mint.example', 'alice', 30)
    vi.resetModules()
    const again = await import('./addressRegistry')
    const [addr] = again.registeredAddresses()
    expect(addr.nextScanIndex).toBe(7)
    expect(addr.lastAutoScanAt).toBe(1234)
    expect(addr.autoScanMinutes).toBe(30)
  })

  it('removes and clears', () => {
    registry.addRegisteredAddress('https://mint.example', 'alice')
    registry.addRegisteredAddress('https://other.example', 'bob')
    registry.removeRegisteredAddress('https://mint.example', 'ALICE')
    expect(registry.registeredAddresses().map(a => a.username)).toEqual(['bob'])
    registry.clearRegisteredAddresses()
    expect(registry.registeredAddresses()).toEqual([])
    expect(store.size).toBe(0)
  })

  it('merges a backup without overriding what this device knows', () => {
    registry.addRegisteredAddress('https://mint.example', 'alice', NPUB)
    registry.markAddressScanned('https://mint.example', 'alice', 9)
    const added = registry.mergeRegisteredAddresses([
      {
        server: 'https://mint.example',
        username: 'alice',
        registeredAt: 1,
        nextScanIndex: 2
      },
      {
        server: 'https://other.example',
        username: 'bob',
        registeredAt: 2,
        npub: 'npub1bad'
      },
      {server: '::not a url::', username: 'x', registeredAt: 3},
      'garbage'
    ])
    expect(added).toBe(1)
    const all = registry.registeredAddresses()
    expect(all).toHaveLength(2)
    expect(all[0].nextScanIndex).toBe(9)
    expect(all[0].npub).toBe(NPUB)
    expect(all[1].username).toBe('bob')
    expect(all[1].npub).toBeUndefined()
    expect(registry.mergeRegisteredAddresses('not a list')).toBe(0)
  })

  it('drops malformed stored records instead of throwing', async () => {
    store.set(
      'lnurlcash_registered_addresses',
      '[{"server":"https://mint.example","username":"ok","registeredAt":1},{"server":5}]'
    )
    vi.resetModules()
    const again = await import('./addressRegistry')
    expect(again.registeredAddresses().map(a => a.username)).toEqual(['ok'])
    store.set('lnurlcash_registered_addresses', '{not json')
    vi.resetModules()
    expect((await import('./addressRegistry')).registeredAddresses()).toEqual(
      []
    )
  })
})

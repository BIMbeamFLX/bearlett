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

let links: typeof import('./storeableLinks')

beforeEach(async () => {
  store.clear()
  vi.resetModules()
  links = await import('./storeableLinks')
})

describe('storeable melt addresses', () => {
  it('records whether an address advertised internal transfers, and updates it', () => {
    links.addStoreableMeltAddress('alice@mint.example')
    expect(links.storeableMeltAddresses()[0].internalTransfer).toBeUndefined()
    links.addStoreableMeltAddress('alice@mint.example', true)
    expect(links.storeableMeltAddresses()[0].internalTransfer).toBe(true)
    links.addStoreableMeltAddress('alice@mint.example')
    expect(links.storeableMeltAddresses()[0].internalTransfer).toBe(true)
    links.addStoreableMeltAddress('alice@mint.example', false)
    expect(links.storeableMeltAddresses()[0].internalTransfer).toBeUndefined()
    expect(links.storeableMeltAddresses()).toHaveLength(1)
  })

  it('keeps the flag across a reload and drops anything that is not true', async () => {
    links.addStoreableMeltAddress('bob@mint.example', true)
    store.set(
      'lnurlcash_storeable_melt_addresses',
      JSON.stringify([
        ...JSON.parse(store.get('lnurlcash_storeable_melt_addresses')!),
        {address: 'x@y', addedAt: 1, internalTransfer: 'yes'}
      ])
    )
    vi.resetModules()
    const again = await import('./storeableLinks')
    const all = again.storeableMeltAddresses()
    expect(
      all.find(l => l.address === 'bob@mint.example')?.internalTransfer
    ).toBe(true)
    expect(all.find(l => l.address === 'x@y')?.internalTransfer).toBeUndefined()
  })

  it('mint links never carry the flag', () => {
    links.addStoreableMint('mint@mint.example')
    expect(links.storeableMints()[0]).toEqual({
      address: 'mint@mint.example',
      addedAt: expect.any(Number)
    })
  })
})

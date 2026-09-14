import {describe, expect, it} from 'vitest'
import {
  WalletUnreadable,
  createWalletSlots,
  createWalletStore,
  hostWalletKey,
  isStoredWallet,
  readWallet,
  storageKeyFor
} from './wallets'
import type {Codec} from './wallets'

const memory = () => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      map.set(key, value)
    }
  }
}

const wallet = {
  privateKey: '11'.repeat(32),
  pubkey: '02' + '22'.repeat(32),
  seedPhrase: 'not a real phrase',
  counters: {},
  tokens: [],
  outgoing: [],
  pending: null
}

describe('the storage layout', () => {
  it('keeps the random wallet where the collection always kept it', () => {
    expect(storageKeyFor({id: '600b-e1'})).toBe('bearlett:nutft:600b-e1')
  })

  it('names an account wallet by fingerprint beside it', () => {
    expect(hostWalletKey({id: '600b-e1'}, '0123456789abcdef')).toBe(
      'bearlett:nutft:600b-e1:0123456789abcdef'
    )
  })
})

describe('readWallet', () => {
  it('reads absent as null, as the library does', async () => {
    const store = memory()
    expect(await readWallet(store, 'k')).toBeNull()
    store.map.set('k', '')
    expect(await readWallet(store, 'k')).toBeNull()
  })

  it('refuses a damaged wallet without repeating what it holds', async () => {
    const store = memory()
    for (const damaged of [
      '{"privateKey":"secret-material"',
      JSON.stringify({...wallet, tokens: 'cashuBsecret'}),
      JSON.stringify({...wallet, seedSource: 'guessed'}),
      JSON.stringify({...wallet, restore: true})
    ]) {
      store.map.set('k', damaged)
      const error = await readWallet(store, 'k').catch(e => e)
      expect(error).toBeInstanceOf(WalletUnreadable)
      expect(String(error.message)).not.toMatch(/secret/)
    }
  })

  it('accepts the fields the collection adds', () => {
    expect(
      isStoredWallet({...wallet, seedSource: 'host', restore: 'pending'})
    ).toBe(true)
    expect(isStoredWallet({...wallet, seedSource: 'random'})).toBe(true)
  })
})

describe('createWalletStore', () => {
  it('seals only the keys that asked for it', async () => {
    const storage = memory()
    const store = createWalletStore(storage)
    const codec: Codec = {
      seal: async (value, key) => `sealed(${key}):${value}`,
      open: async (stored, key) => stored.replace(`sealed(${key}):`, '')
    }
    store.protect('account', codec)
    await store.setItem('account', 'state')
    await store.setItem('cache', 'public')
    expect(storage.map.get('account')).toBe('sealed(account):state')
    expect(storage.map.get('cache')).toBe('public')
    expect(await store.getItem('account')).toBe('state')
    expect(await store.getItem('absent')).toBeNull()
  })
})

describe('createWalletSlots', () => {
  it('points the library key at the selected wallet and passes the rest', async () => {
    const storage = memory()
    const slots = createWalletSlots(storage, 'bearlett:nutft:600b-e1')
    await slots.port.setItem('bearlett:nutft:600b-e1', 'random')
    slots.select('bearlett:nutft:600b-e1:0123456789abcdef')
    expect(slots.selected()).toBe('bearlett:nutft:600b-e1:0123456789abcdef')
    await slots.port.setItem('bearlett:nutft:600b-e1', 'account')
    await slots.port.setItem('600b:nutft-catalogs-v1', 'catalogue')
    expect(Object.fromEntries(storage.map)).toEqual({
      'bearlett:nutft:600b-e1': 'random',
      'bearlett:nutft:600b-e1:0123456789abcdef': 'account',
      '600b:nutft-catalogs-v1': 'catalogue'
    })
    expect(await slots.port.getItem('bearlett:nutft:600b-e1')).toBe('account')
  })
})

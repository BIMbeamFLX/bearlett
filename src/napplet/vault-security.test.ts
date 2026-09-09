import {describe, expect, it, vi} from 'vitest'
import {Vault} from './vault'
import {CashuEngine} from './cashu/engine'
import {TestMint} from './cashu/fixture'

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const other =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const password = 'independent wallet password'
const create = async (seed = phrase) => {
  const records = new Map<string, string>()
  const storage = {
    getItem: async (key: string) => records.get(key) ?? null,
    setItem: vi.fn(async (key: string, value: string) => {
      records.set(key, value)
    }),
    keys: async () => [...records.keys()]
  }
  const vault = new Vault(storage)
  await vault.create(password, seed)
  return {vault, records, storage}
}

describe('authenticated full wallet backup', () => {
  it('rejects removal of an entire encrypted record before any target write', async () => {
    const source = await create()
    await new CashuEngine(source.vault, new TestMint()).enable(phrase, false)
    const backup = JSON.parse(await source.vault.backup())
    delete backup.metadata['cashu-v1']
    const target = await create()
    target.storage.setItem.mockClear()
    await expect(
      target.vault.restore(JSON.stringify(backup), password)
    ).rejects.toThrow()
    expect(target.storage.setItem).not.toHaveBeenCalled()
  })
  it('refuses a foreign Cashu seed even before Cashu is enabled in the target', async () => {
    const source = await create()
    await new CashuEngine(source.vault, new TestMint()).enable(phrase, false)
    const target = await create(other)
    target.storage.setItem.mockClear()
    await expect(
      target.vault.restore(await source.vault.backup(), password)
    ).rejects.toThrow(/phrase|seed/i)
    expect(target.storage.setItem).not.toHaveBeenCalled()
  })
})

it('a late password unlock cannot undo a wallet lock', async () => {
  const {vault} = await create()
  vault.lock()
  const pending = vault.unlock(password)
  vault.lock()
  await expect(pending).rejects.toThrow(/session|lock/i)
  await expect(vault.notes()).rejects.toThrow(/unlock/i)
})

it('a late recovery password reset cannot undo a wallet lock', async () => {
  const {vault} = await create()
  vault.lock()
  const pending = vault.resetPassword(phrase, 'replacement wallet password')
  vault.lock()
  await expect(pending).rejects.toThrow(/session|lock/i)
  await expect(vault.notes()).rejects.toThrow(/unlock/i)
})

it('a lock during a metadata read never returns decrypted wallet secrets', async () => {
  const {vault, storage} = await create()
  await vault.setMeta('secret', {value: 'sensitive'})
  const original = storage.getItem
  storage.getItem = async key => {
    const value = await original(key)
    vault.lock()
    return value
  }
  await expect(vault.meta('secret')).rejects.toThrow(/session|lock/i)
})

it('a late wallet creation cannot undo a lock', async () => {
  const records = new Map<string, string>()
  const vault = new Vault({
    getItem: async k => records.get(k) ?? null,
    setItem: async (k, v) => {
      records.set(k, v)
    },
    keys: async () => [...records.keys()]
  })
  const pending = vault.create(password, phrase)
  vault.lock()
  await expect(pending).rejects.toThrow(/session|lock/i)
  await expect(vault.notes()).rejects.toThrow(/unlock/i)
})

it('a note read in flight cannot return secrets after lock', async () => {
  const {vault, storage} = await create()
  const original = storage.keys
  storage.keys = async () => {
    const keys = await original()
    vault.lock()
    return keys
  }
  await expect(vault.notes()).rejects.toThrow(/session|lock/i)
})

it('a scanned flag cannot authorize output reuse under a recovered LNURLcash root', async () => {
  const {vault} = await create()
  const cash = await vault.meta<import('./vault').CashState>('cash')
  await vault.setMeta('cash', {
    ...cash!,
    restored: true,
    scanned: ['mint.example']
  })
  await expect(vault.nextSecret('mint.example')).rejects.toThrow(
    /fresh wallet/i
  )
})

it('restoring an old full backup quarantines an existing matching LNURLcash seed', async () => {
  const source = await create()
  const target = await create()
  await target.vault.restore(await source.vault.backup(), password)
  await expect(target.vault.nextSecret('mint.example')).rejects.toThrow(
    /fresh wallet/i
  )
})

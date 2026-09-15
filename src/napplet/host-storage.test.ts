import {afterEach, expect, it, vi} from 'vitest'
import {getWalletHost} from './host'

afterEach(() => vi.unstubAllGlobals())

it('rejects a negative host write acknowledgement even when the SDK discards it', async () => {
  const listeners = new Set<(event: unknown) => void>()
  const parent = {
    postMessage: (message: {id: string; type: string}) => {
      queueMicrotask(() =>
        listeners.forEach(listener =>
          listener({
            source: parent,
            data: {id: message.id, type: message.type + '.result', ok: false}
          })
        )
      )
    }
  }
  vi.stubGlobal('window', {
    parent,
    napplet: {
      storage: {
        setItem: async () => {},
        getItem: async () => null,
        keys: async () => []
      },
      resource: {}
    },
    addEventListener: (_: string, listener: (event: unknown) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: unknown) => void) =>
      listeners.delete(listener)
  })
  await expect(
    getWalletHost().storage.setItem('journal', 'ciphertext')
  ).rejects.toThrow(/storage|write/i)
})

it('removes a key through the host and waits for it to confirm', async () => {
  const listeners = new Set<(event: unknown) => void>()
  const asked: Array<Record<string, unknown>> = []
  const parent = {
    postMessage: (message: {id: string; type: string}) => {
      asked.push(message)
      queueMicrotask(() =>
        listeners.forEach(listener =>
          listener({
            source: parent,
            data: {id: message.id, type: message.type + '.result', ok: true}
          })
        )
      )
    }
  }
  vi.stubGlobal('window', {
    parent,
    napplet: {storage: {}, resource: {}},
    addEventListener: (_: string, listener: (event: unknown) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: unknown) => void) =>
      listeners.delete(listener)
  })
  await getWalletHost().storage.removeItem!('inventory')
  expect(asked).toEqual([
    {type: 'storage.remove', id: expect.any(String), key: 'inventory'}
  ])
})

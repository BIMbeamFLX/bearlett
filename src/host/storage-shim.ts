import type {WalletHost} from '../napplet/host'

/** Require explicit success from the source-bound host; older ambiguous replies fail closed. */
export function walletStorage(parentWindow: Window): WalletHost['storage'] {
  const request = (
    type: string,
    fields: Record<string, string> = {}
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const finish = () => {
        clearTimeout(timer)
        window.removeEventListener('message', listener)
      }
      const listener = (event: MessageEvent) => {
        const reply = event.data
        if (
          event.source !== parentWindow ||
          reply?.id !== id ||
          reply.type !== type + '.result'
        )
          return
        finish()
        if (reply.ok !== true || reply.error) {
          reject(
            new Error(
              'Wallet storage did not confirm success. Keep pending operations for reconciliation.'
            )
          )
        } else resolve(reply)
      }
      const timer = setTimeout(() => {
        finish()
        reject(
          new Error(
            'Wallet storage timed out. Unlock and reconcile before retrying.'
          )
        )
      }, 30000)
      window.addEventListener('message', listener)
      try {
        parentWindow.postMessage({type, id, ...fields}, '*')
      } catch {
        finish()
        reject(new Error('Wallet storage is unavailable.'))
      }
    })
  return {
    async getItem(key) {
      const reply = await request('storage.get', {key})
      if (reply.value !== null && typeof reply.value !== 'string')
        throw new Error('Invalid wallet storage read.')
      return reply.value as string | null
    },
    async setItem(key, value) {
      await request('storage.set', {key, value})
    },
    async keys() {
      const reply = await request('storage.keys')
      if (
        !Array.isArray(reply.keys) ||
        !reply.keys.every(key => typeof key === 'string')
      )
        throw new Error('Invalid wallet storage inventory.')
      return reply.keys
    }
  }
}

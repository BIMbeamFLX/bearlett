import type {NutftHost} from './nutft-contract'

/** Inject only when the shell grants NutFT. Replies must originate from this iframe's parent. */
export function installNutftShim(): NutftHost & {
  acquire(): Promise<void>
  dispose(): void
} {
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent) return
    const msg = event.data
    if (
      !msg ||
      !['nutft.request.result', 'nutft.acquire.result'].includes(msg.type)
    )
      return
    const call = pending.get(msg.id)
    if (!call) return
    pending.delete(msg.id)
    clearTimeout(call.timer)
    if (msg.ok) call.resolve(msg.result)
    else
      call.reject(
        new Error(
          typeof msg.error === 'string' ? msg.error : 'Mint request failed.'
        )
      )
  }
  window.addEventListener('message', listener)
  const call = (type: string, request?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new Error('Shell request timed out. Reconcile the stored operation.')
        )
      }, 60000)
      pending.set(id, {resolve, reject, timer})
      window.parent.postMessage({type, id, ...(request ? {request} : {})}, '*')
    })
  return {
    request: request =>
      call('nutft.request', request) as ReturnType<NutftHost['request']>,
    acquire: async () => {
      await call('nutft.acquire')
    },
    dispose: () => {
      window.removeEventListener('message', listener)
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Collection window closed.'))
      }
      pending.clear()
    }
  }
}

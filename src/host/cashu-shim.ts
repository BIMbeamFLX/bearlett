import type {CashuHost} from '../napplet/cashu/transport'

/** Inject only when the shell grants Cashu. Replies must originate from this iframe's parent. */
export function installCashuShim(): CashuHost & {
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
      !['cashu.request.result', 'cashu.acquire.result'].includes(msg.type)
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
          typeof msg.error === 'string' ? msg.error : 'Cashu request failed.'
        )
      )
  }
  window.addEventListener('message', listener)
  const call = (type: string, request?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id)
          reject(
            new Error(
              'Shell request timed out. Reconcile the stored operation.'
            )
          )
        }, 310000)
      pending.set(id, {resolve, reject, timer})
      window.parent.postMessage({type, id, ...(request ? {request} : {})}, '*')
    })
  return {
    request: request =>
      call('cashu.request', request) as ReturnType<CashuHost['request']>,
    acquire: async () => {
      await call('cashu.acquire')
    },
    dispose: () => {
      window.removeEventListener('message', listener)
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Wallet window closed.'))
      }
      pending.clear()
    }
  }
}

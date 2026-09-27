// The bridge from the wallet core to Solid: one signal that bumps on every
// wallet change, a toast, and a helper that runs an action and reports how
// it went in words a holder can act on.
import {createSignal} from 'solid-js'
import {ProtocolError, ServiceError, TransportError} from '../lnurl/errors.ts'
import {TollGateNotice} from '../tollgate/tollgate.ts'
import {MintKeyChangedError, type Wallet} from '../wallet/wallet.ts'
import {WrongPassphraseError} from '../wallet/vault.ts'

export type Toast = {text: string; error?: boolean}

const [toast, setToast] = createSignal<Toast | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | undefined

export {toast}

export const notify = (text: string, error = false): void => {
  clearTimeout(toastTimer)
  setToast({text, error})
  toastTimer = setTimeout(() => setToast(null), error ? 9000 : 4000)
}

/** What went wrong, for a holder: SERVICE's reason verbatim, else ours. */
export const describe = (err: unknown): string => {
  if (err instanceof ServiceError) return `The mint says: ${err.reason}`
  if (err instanceof TollGateNotice) return `The TollGate says: ${err.message}`
  if (err instanceof ProtocolError)
    return `An answer Bearlett cannot trust: ${err.message}`
  if (err instanceof TransportError)
    return `${err.message} If a payment was underway, Bearlett will check it again.`
  if (err instanceof MintKeyChangedError)
    return `${err.message} Bearlett stops trusting its certificates until you check why.`
  if (err instanceof WrongPassphraseError) return err.message
  return err instanceof Error ? err.message : String(err)
}

const [busy, setBusy] = createSignal<string | null>(null)
export {busy}

/** Runs one action at a time, with a label while it runs. */
export const run = async <T>(
  label: string,
  action: () => Promise<T>
): Promise<T | undefined> => {
  if (busy()) return undefined
  setBusy(label)
  try {
    return await action()
  } catch (err) {
    notify(describe(err), true)
    return undefined
  } finally {
    setBusy(null)
  }
}

/** A signal that follows the wallet: read it inside JSX to re-render. */
export const watchWallet = (wallet: Wallet): (() => Wallet) => {
  const [version, setVersion] = createSignal(0)
  wallet.subscribe(() => setVersion(v => v + 1))
  return () => (version(), wallet)
}

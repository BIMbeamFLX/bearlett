// What differs between the web app and the Hangar napplet, in one place.
import type {Net} from '../lnurl/net.ts'
import type {Store} from '../wallet/store.ts'

export type Platform = {
  kind: 'web' | 'napplet'
  net: Net
  store: Store
  /** a camera to scan QR codes with */
  canScan: boolean
  /** note designs handed over by the shell (the Hangar's Note Designer) */
  designs?: (listener: (payload: unknown, sender: string) => void) => () => void
}

/**
 * One tab at a time writes the wallet: a second tab of the web app would
 * race the first for counters and journal entries.
 */
export const holdWalletLock = async (): Promise<boolean> => {
  const locks = navigator.locks
  if (!locks) return true
  return new Promise(resolve => {
    locks
      .request('bearlett-wallet', {ifAvailable: true}, lock => {
        resolve(lock !== null)
        // held for the life of the page
        return lock ? new Promise<void>(() => {}) : undefined
      })
      .catch(() => resolve(true))
  })
}

// What differs between the web app and the Hangar napplet, in one place.
import type {Net} from '../lnurl/net.ts'
import type {Store} from '../wallet/store.ts'
import type {TollGateHttp} from '../tollgate/tollgate.ts'

export type Platform = {
  kind: 'web' | 'napplet'
  net: Net
  store: Store
  /** a camera to scan QR codes with */
  canScan: boolean
  /** HTTP-01 to TollGates: a napplet reaches nothing but GETs through its shell */
  tollgate?: TollGateHttp
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

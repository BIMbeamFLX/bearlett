// What differs between the web app and the Hangar napplet, in one place.
import {fetchNet, type Net} from '../lnurl/net.ts'
import {localStore, type Store} from '../wallet/store.ts'
import {resourceNet, shell, shellStore} from './napplet.ts'

export type Platform = {
  kind: 'web' | 'napplet'
  net: Net
  store: Store
  /** a camera to scan QR codes with */
  canScan: boolean
}

export const webPlatform = (): Platform => ({
  kind: 'web',
  net: fetchNet,
  store: localStore(),
  canScan: Boolean(navigator.mediaDevices?.getUserMedia)
})

export const nappletPlatform = (): Platform => {
  const resource = shell()?.resource as
    Parameters<typeof resourceNet>[0] | undefined
  if (!resource)
    throw new Error(
      'Open Bearlett in a napplet shell that grants NAP-RESOURCE.'
    )
  return {
    kind: 'napplet',
    net: resourceNet(resource),
    store: shellStore(),
    canScan: false
  }
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

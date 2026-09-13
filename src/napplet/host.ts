import type {storage, resource, inc} from '@napplet/sdk'
import type {CashuHost} from './cashu/transport'
import {walletStorage} from '../host/storage-shim'

export type WalletHost = {
  cashu?: CashuHost
  storage: Pick<typeof storage, 'getItem' | 'setItem' | 'keys'>
  resource: Pick<typeof resource, 'bytes'>
  /** `emit` as well as `on`: the collection answers requests on its topic. */
  inc?: Pick<typeof inc, 'on' | 'emit'>
}

/** Refuse an ephemeral wallet when the shell cannot persist its secrets. */
export const getWalletHost = (): WalletHost => {
  const host = window.napplet
  if (!host?.storage || !host.resource) {
    throw new Error(
      'Open this wallet in a napplet shell with storage and resource support.'
    )
  }
  return {
    storage: walletStorage(window.parent),
    resource: host.resource,
    inc: host.inc,
    cashu: typeof host.cashu?.acquire === 'function' ? host.cashu : undefined
  }
}

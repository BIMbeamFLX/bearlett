import type {storage, resource, inc, intent} from '@napplet/sdk'

declare global {
  interface Window {
    napplet?: {
      storage?: typeof storage
      resource?: typeof resource
      inc?: typeof inc
      intent?: typeof intent
    }
  }
}

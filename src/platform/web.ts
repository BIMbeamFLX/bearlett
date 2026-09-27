// The web app's ports: fetch for mints, localStorage for the sealed
// records. Only the web entry imports this file, so the napplet bundle never
// carries either (NIP-5D forbids them in a napplet).
import {TransportError} from '../lnurl/errors.ts'
import {parseLnurlJson, requireServiceUrl, type Net} from '../lnurl/net.ts'
import type {Store} from '../wallet/store.ts'
import type {Platform} from './platform.ts'

/** fetch() for browsers: the web app's Net. */
export const fetchNet: Net = {
  async get(url, options = {}) {
    requireServiceUrl(url)
    let response: Response
    try {
      response = await fetch(url, {
        signal: options.signal,
        redirect: options.secret ? 'error' : 'follow',
        headers: {accept: 'application/json'}
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new TransportError(`No answer from ${new URL(url).host}.`)
    }
    return parseLnurlJson(await response.text())
  },
  async send(method, url, options = {}) {
    requireServiceUrl(url)
    let response: Response
    try {
      response = await fetch(url, {
        method,
        signal: options.signal,
        redirect: 'error',
        headers: {accept: 'application/json'}
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new TransportError(`No answer from ${new URL(url).host}.`)
    }
    return parseLnurlJson(await response.text())
  }
}

export const localStore = (storage: Storage = localStorage): Store => ({
  async get(key) {
    return storage.getItem(key)
  },
  async set(key, value) {
    storage.setItem(key, value)
  },
  async remove(key) {
    storage.removeItem(key)
  }
})

export const webPlatform = (): Platform => ({
  kind: 'web',
  net: fetchNet,
  store: localStore(),
  canScan: Boolean(navigator.mediaDevices?.getUserMedia)
})

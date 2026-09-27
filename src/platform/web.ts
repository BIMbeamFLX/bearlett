// The web app's ports: fetch for mints and TollGates, localStorage for the
// sealed records. Only the web entry imports this file, so the napplet
// bundle never carries either (NIP-5D forbids them in a napplet).
import {ProtocolError, TransportError} from '../lnurl/errors.ts'
import {parseLnurlJson, requireServiceUrl, type Net} from '../lnurl/net.ts'
import {isTollGateUrl, type TollGateHttp} from '../tollgate/tollgate.ts'
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

const MAX_TOLLGATE_ANSWER = 64 * 1024

const askTollGate = async (
  url: string,
  init: RequestInit
): Promise<unknown> => {
  if (!isTollGateUrl(url))
    throw new ProtocolError(`Not a TollGate address: ${url}`)
  let text: string
  try {
    const response = await fetch(url, {...init, redirect: 'error'})
    text = await response.text()
  } catch (err) {
    throw new TransportError(
      `No answer from the TollGate: ${(err as Error).message}`
    )
  }
  if (text.length > MAX_TOLLGATE_ANSWER)
    throw new TransportError('The TollGate answer is too large.')
  try {
    return JSON.parse(text)
  } catch {
    throw new TransportError('The TollGate did not answer with an event.')
  }
}

/** HTTP-01 over fetch; a TollGate answers a refusal with 400, still an event. */
export const fetchTollGate: TollGateHttp = {
  get: url => askTollGate(url, {}),
  post: (url, body) =>
    askTollGate(url, {
      method: 'POST',
      body,
      headers: {'content-type': 'text/plain'}
    })
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
  canScan: Boolean(navigator.mediaDevices?.getUserMedia),
  tollgate: fetchTollGate
})

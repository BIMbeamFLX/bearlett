// The Hangar napplet's ports. The shell reaches mints for us through
// NAP-RESOURCE (GET only) and keeps our sealed records in its storage
// domain. Both are asked through window.napplet or the parent frame; the
// wallet core never knows which platform it runs on.
import {TransportError} from '../lnurl/errors.ts'
import {parseLnurlJson, requireServiceUrl, type Net} from '../lnurl/net.ts'
import type {Store} from '../wallet/store.ts'
import type {Platform} from './platform.ts'
import {DESIGN_TOPIC} from '../wallet/design.ts'

type Resource = {
  bytes(url: string, options?: {signal?: AbortSignal}): Promise<Blob>
}

type Shell = {resource?: Resource; storage?: unknown; theme?: unknown}

export const shell = (): Shell | undefined =>
  (globalThis as {napplet?: Shell}).napplet

const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * NAP-RESOURCE may cache by URL, and LNURL mutations are GETs: every request
 * gets a fresh throwaway parameter so none is ever served from a cache.
 * Mints ignore unknown query parameters, and a replayed burn is matched on
 * the notes it names, not on the raw URL.
 */
export const resourceNet = (resource: Resource): Net => ({
  async get(url, options = {}) {
    const fresh = requireServiceUrl(url)
    fresh.searchParams.set('_bearlett', crypto.randomUUID())
    let blob: Blob
    try {
      blob = await resource.bytes(fresh.toString(), {signal: options.signal})
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new TransportError(`No answer from ${fresh.host}.`)
    }
    if (blob.size > MAX_RESPONSE_BYTES)
      throw new TransportError('The response is too large.')
    return parseLnurlJson(await blob.text())
  }
})

/**
 * The shell's storage, asked directly over postMessage so that every write
 * must be confirmed: a wallet cannot treat an unanswered write as done.
 */
export const shellStore = (parent: Window = window.parent): Store => {
  const request = (
    type: string,
    fields: Record<string, string> = {}
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const done = () => {
        clearTimeout(timer)
        window.removeEventListener('message', listen)
      }
      const listen = (event: MessageEvent) => {
        const reply = event.data
        if (
          event.source !== parent ||
          reply?.id !== id ||
          reply.type !== `${type}.result`
        )
          return
        done()
        if (reply.ok !== true || reply.error)
          reject(new Error('The shell did not confirm storing the wallet.'))
        else resolve(reply)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error('The shell did not answer in time.'))
      }, 30_000)
      window.addEventListener('message', listen)
      parent.postMessage({type, id, ...fields}, '*')
    })
  return {
    async get(key) {
      const reply = await request('storage.get', {key})
      if (reply.value !== null && typeof reply.value !== 'string')
        throw new Error('The shell returned something unreadable.')
      return reply.value as string | null
    },
    async set(key, value) {
      await request('storage.set', {key, value})
    },
    async remove(key) {
      await request('storage.remove', {key})
    }
  }
}

/**
 * Messages the shell's INC delivers on `topic` (the Hangar hands over a
 * note design this way). Nothing arrives where the shell grants no INC:
 * the subscription simply stays unanswered.
 */
export const shellTopic =
  (topic: string, parent: Window = window.parent) =>
  (listener: (payload: unknown, sender: string) => void): (() => void) => {
    const listen = (event: MessageEvent) => {
      const message = event.data
      if (
        event.source === parent &&
        message?.type === 'inc.event' &&
        message.topic === topic
      )
        listener(message.payload, String(message.sender ?? ''))
    }
    window.addEventListener('message', listen)
    parent.postMessage(
      {type: 'inc.subscribe', id: crypto.randomUUID(), topic},
      '*'
    )
    return () => {
      window.removeEventListener('message', listen)
      parent.postMessage(
        {type: 'inc.unsubscribe', id: crypto.randomUUID(), topic},
        '*'
      )
    }
  }

/** The napplet's ports, or an error naming what the shell did not grant. */
export const nappletPlatform = (): Platform => {
  const resource = shell()?.resource as Resource | undefined
  if (typeof resource?.bytes !== 'function')
    throw new Error(
      'This shell does not let Bearlett reach mints (NAP-RESOURCE). Open it in the Nappelin Hangar.'
    )
  return {
    kind: 'napplet',
    net: resourceNet(resource),
    store: shellStore(),
    canScan: false,
    designs: shellTopic(DESIGN_TOPIC)
  }
}

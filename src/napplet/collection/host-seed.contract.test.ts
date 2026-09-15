import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHmac} from 'node:crypto'
import {hexToBytes} from '@noble/hashes/utils.js'
import {installNutftShim} from '../../host/nutft-shim'
import {TestNutftMint, addressOf, device, fingerprint} from './harness'
import {sealedWith} from './sealed'

/*
 * The host seed contract, end to end, with the test vectors nappelin-com-b0
 * pinned for the Nappelin shell (nappelin pull request 103, PLAN.md step 5):
 *
 *   seed = lowercase hex of HMAC-SHA256(key = the 32-byte account secret key,
 *                                       message = UTF-8 "nappelin:nutft:" + scope)
 *
 * Bearlett never derives a seed; the host does, once per lease scope. These
 * tests hand the two vectors to the collection the way the host does, through
 * the lease, and prove the two collections of one account end up with two
 * wallets that share nothing: not a storage key, not an address, and not a
 * sealed state either can open. Account wallets only; the alpha build checks
 * the seed and opens the device wallet.
 */

const ACCOUNT_SECRET =
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
const VECTORS = [
  {
    scope: 'collection-600b-e1',
    edition: '600b-e1',
    mint: 'https://mint.test/e1',
    seed: '5ac043b3d85fb8b50ef62a914a11595b2e2333cabada9160caf054f4d4faaeed'
  },
  {
    scope: 'collection-600b-g',
    edition: '600b-g',
    mint: 'https://mint.test/g',
    seed: 'b1e69e9b78999f8fcbd4271779eebea321a466e627f41ad7a77149fe0cb7c1ea'
  }
] as const

/* A frame whose parent is the host: the shim posts to it and listens for its
   replies, which is all of the lease path it needs. */
const frame = () => {
  const listeners = new Set<(event: MessageEvent) => void>()
  const posted: Array<{type: string; id: string}> = []
  const parent = {
    postMessage: (message: {type: string; id: string}) => {
      posted.push(message)
    }
  }
  return {
    parent,
    posted,
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
    reply: (data: unknown) =>
      listeners.forEach(listener =>
        listener({source: parent, data} as MessageEvent)
      )
  }
}

let host: ReturnType<typeof frame>
beforeEach(() => {
  host = frame()
  vi.stubGlobal('window', host)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/* The seed as the collection receives it: an acquire the host answers. */
const leaseOf = async (seed: string) => {
  const shim = installNutftShim()
  try {
    const lease = shim.acquire()
    const asked = host.posted[host.posted.length - 1]
    expect(asked.type).toBe('nutft.acquire')
    host.reply({
      type: 'nutft.acquire.result',
      id: asked.id,
      ok: true,
      result: {seed}
    })
    return await lease
  } finally {
    shim.dispose()
  }
}

const opened = async (
  vector: (typeof VECTORS)[number],
  accountWallets = true
) => {
  const {seed} = await leaseOf(vector.seed)
  const phone = device(new TestNutftMint({url: vector.mint}), {
    edition: vector.edition,
    accountWallets
  })
  const ui = phone.open(seed)
  const opening = await ui.session.open()
  return {phone, ui, opening, address: await ui.session.destination()}
}

describe('the host seed contract (nappelin #103, PLAN.md step 5)', () => {
  it('pins vectors the documented derivation gives', () => {
    /* The host's derivation, recomputed only so the vectors and the formula
       in docs/NAPPLETS.md cannot drift apart. */
    for (const {scope, seed} of VECTORS)
      expect(
        createHmac('sha256', hexToBytes(ACCOUNT_SECRET))
          .update(`nappelin:nutft:${scope}`)
          .digest('hex')
      ).toBe(seed)
  })

  it('gives each scope a wallet of its own, sharing no key, address or seal', async () => {
    const [e1, g] = [await opened(VECTORS[0]), await opened(VECTORS[1])]
    for (const collection of [e1, g])
      expect(collection.opening).toMatchObject({active: 'host'})

    /* Two fingerprints, so two storage keys. */
    const keyOf = (collection: typeof e1, edition: string) => {
      const keys = [...collection.phone.storage.map.keys()].filter(key =>
        new RegExp(`^bearlett:nutft:${edition}:[0-9a-f]{16}$`).test(key)
      )
      expect(keys).toHaveLength(1)
      return keys[0]
    }
    const e1Key = keyOf(e1, '600b-e1')
    const gKey = keyOf(g, '600b-g')
    expect(e1Key).toBe(`bearlett:nutft:600b-e1:${fingerprint(VECTORS[0].seed)}`)
    expect(gKey).toBe(`bearlett:nutft:600b-g:${fingerprint(VECTORS[1].seed)}`)
    expect(e1Key.slice(-16)).not.toBe(gKey.slice(-16))

    /* Two wallets, each on the documented recipe for its own seed. */
    expect(e1.address).toBe(addressOf(VECTORS[0].seed).pubkey)
    expect(g.address).toBe(addressOf(VECTORS[1].seed).pubkey)
    expect(e1.address).not.toBe(g.address)

    /* Neither seed opens the other's sealed state, under either key. */
    const e1Sealed = e1.phone.storage.map.get(e1Key)!
    const gSealed = g.phone.storage.map.get(gKey)!
    const e1Codec = sealedWith(VECTORS[0].seed)
    const gCodec = sealedWith(VECTORS[1].seed)
    expect(JSON.parse(await e1Codec.open(e1Sealed, e1Key)).pubkey).toBe(
      e1.address
    )
    expect(JSON.parse(await gCodec.open(gSealed, gKey)).pubkey).toBe(g.address)
    await expect(gCodec.open(e1Sealed, e1Key)).rejects.toThrow()
    await expect(gCodec.open(e1Sealed, gKey)).rejects.toThrow()
    await expect(e1Codec.open(gSealed, gKey)).rejects.toThrow()
    await expect(e1Codec.open(gSealed, e1Key)).rejects.toThrow()

    /* And a collection given the other's sealed wallet under its own key
       refuses to open it rather than reading it. */
    g.phone.storage.map.set(gKey, e1Sealed)
    await expect(g.phone.open(VECTORS[1].seed).session.open()).rejects.toThrow()
    expect(g.phone.storage.map.get(gKey)).toBe(e1Sealed)
  })

  it('opens the device wallet for either seed in the alpha build', async () => {
    for (const vector of VECTORS) {
      const collection = await opened(vector, false)
      expect(collection.opening).toMatchObject({
        active: 'random',
        migration: 'none'
      })
      expect(
        [...collection.phone.storage.map.keys()].filter(key =>
          /:[0-9a-f]{16}$/.test(key)
        )
      ).toEqual([])
      expect(collection.address).not.toBe(addressOf(vector.seed).pubkey)
    }
  })
})

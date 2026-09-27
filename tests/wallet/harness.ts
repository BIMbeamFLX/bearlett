// A mock mint in process (lnurlcash-conformance's adversarial mock, with its
// test hooks), wallets on memory stores, and nets that fail on purpose.
import {
  createMockMint,
  type MockMintOptions
} from 'lnurlcash-conformance/mock-mint'
import {TransportError} from '../../src/lnurl/errors.ts'
import type {Net} from '../../src/lnurl/net.ts'
import {fetchNet} from '../../src/platform/web.ts'
import {memoryStore, type Store} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
import {Wallet} from '../../src/wallet/wallet.ts'

export type Mint = Awaited<ReturnType<typeof createMockMint>>

export const startMint = (options: MockMintOptions = {}): Promise<Mint> =>
  createMockMint({testHooks: true, ...options})

export const payUrl = (mint: Mint): string =>
  `${mint.url}/.well-known/lnurlp/mint`

export const hostOfMint = (mint: Mint): string => new URL(mint.url).host

/** Pays a mint invoice through the mock's hook, by the hash in its verify URL. */
export const payInvoice = async (mint: Mint, verify: string): Promise<void> => {
  const hash = new URL(verify).pathname.split('/').pop()
  const answer = await fetch(`${mint.url}/_test/settle?payment_hash=${hash}`)
  if (!(await answer.json()).settled) throw new Error('the mock did not settle')
}

export type Setup = {
  net?: Net
  store?: Store
  words?: string
  passphrase?: string
}

/** A wallet with `mint` added and, if asked, `fundMsat` minted there. */
export const walletAt = async (
  mint: Mint,
  fundMsat = 0,
  setup: Setup = {}
): Promise<Wallet> => {
  const wallet = await Wallet.create(
    {net: setup.net ?? fetchNet, store: setup.store ?? memoryStore()},
    setup.words ?? newMnemonic(),
    setup.passphrase ?? ''
  )
  const {domain} = await wallet.addMint(payUrl(mint))
  if (fundMsat) {
    const op = await wallet.requestMint(domain, fundMsat)
    await payInvoice(mint, op.verify!)
    if (!(await wallet.settleMint(op)))
      throw new Error('the mint did not credit')
  }
  return wallet
}

/** fetchNet, but the answers to requests `match` picks are lost after they land. */
export const losing = (match: (url: URL) => boolean, times = 1): Net => {
  let left = times
  return {
    async get(url, options) {
      const body = await fetchNet.get(url, options)
      if (left > 0 && match(new URL(url))) {
        left--
        throw new TransportError('The answer was lost.')
      }
      return body
    }
  }
}

/** fetchNet, but requests `match` picks reach the mint and never come back. */
export const hanging = (match: (url: URL) => boolean): Net => ({
  async get(url, options) {
    const body = fetchNet.get(url, options)
    if (!match(new URL(url))) return body
    await body.catch(() => undefined)
    return new Promise(() => {})
  }
})

/** fetchNet, with every answer passed through `rewrite` first. */
export const rewriting = (
  rewrite: (url: URL, body: Record<string, unknown>) => Record<string, unknown>
): Net => ({
  async get(url, options) {
    return rewrite(new URL(url), await fetchNet.get(url, options))
  }
})

export const isCallback = (url: URL): boolean => url.pathname === '/w/cb'
export const isBurn = (url: URL): boolean =>
  isCallback(url) && url.searchParams.has('p1')

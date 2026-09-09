import {expect, it, vi} from 'vitest'
import {Vault} from '../../src/napplet/vault'
import {Bearlett} from '../../src/napplet/bearlett'
import {Transfers} from '../../src/napplet/transfers'
import {cashuEndpoint} from '../../src/host/cashu-service'
import type {CashuHost} from '../../src/napplet/cashu/transport'
import {lightning} from '../../scripts/regtest.mjs'
import {generateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'

const phrase = generateMnemonic(wordlist)
const password = 'regtest wallet password'
const cashuUrl = 'https://cashu-regtest.test'
const lnurlUrl = 'https://lnurl-regtest.test/.well-known/lnurlp/mint'
async function until(check: () => Promise<boolean>) {
  let error: unknown
  for (let i = 0; i < 30; i++) {
    try {
      if (await check()) return
    } catch (e) {
      error = e
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw error ?? new Error('Regtest did not settle within 30 seconds.')
}
const makeVault = async () => {
  const data = new Map<string, string>()
  const vault = new Vault({
    getItem: async k => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v)
    },
    keys: async () => [...data.keys()]
  })
  await vault.create(password, phrase)
  return vault
}
it('settles both protocols through real LND and restores a transfer after losing its melt response', async () => {
  vi.stubEnv('MODE', 'napplet')
  vi.stubGlobal('window', {
    napplet: {
      resource: {
        bytes: async (input: string) => {
          const url = new URL(input)
          if (url.origin !== 'https://lnurl-regtest.test')
            throw new Error('Unknown test mint.')
          return (
            await fetch('http://127.0.0.1:48111' + url.pathname + url.search)
          ).blob()
        }
      }
    }
  })
  let loseMelt = false,
    melts = 0
  const host: CashuHost = {
    request: async request => {
      if (request.mint !== cashuUrl) throw new Error('Unknown test mint.')
      const endpoint = cashuEndpoint(request)
      const response = await fetch(
        endpoint.url.replace(cashuUrl, 'http://127.0.0.1:43338'),
        {
          method: endpoint.method,
          body: request.body,
          headers: {'Content-Type': 'application/json'}
        }
      )
      const body = await response.text()
      if (request.operation === 'melt') {
        melts++
        if (loseMelt) {
          loseMelt = false
          throw new Error('Simulated lost melt response')
        }
      }
      return {status: response.status, body}
    }
  }
  try {
    let vault = await makeVault(),
      wallet = new Bearlett(vault, host)
    await wallet.cashu.enable(phrase, false)
    const invoice = await wallet.mint(lnurlUrl, 1024000)
    expect(
      lightning('bob', 'payinvoice', '--force', '--json', invoice).status
    ).toBe('SUCCEEDED')
    const funding = (await vault.notes()).find(n => n.invoice === invoice)!
    await until(async () => {
      await wallet.refresh(funding.id)
      return (
        (await vault.notes()).find(n => n.id === funding.id)?.status === 'ready'
      )
    })
    expect((await vault.notes()).find(n => n.id === funding.id)?.amount).toBe(
      1023000
    )
    let transfers = new Transfers(vault, wallet.cashu)
    const toCashu = await transfers.prepare(
      'lnurlcash',
      [funding.id],
      'cashu',
      cashuUrl,
      128000
    )
    try {
      await transfers.confirm(toCashu.id)
    } catch {}
    await until(async () => {
      await transfers.resume(toCashu.id)
      return (
        (await transfers.list()).find(t => t.id === toCashu.id)?.phase ===
        'complete'
      )
    })
    expect(
      (await wallet.cashu.notes())
        .filter(n => n.status === 'ready')
        .reduce((sum, n) => sum + n.amount, 0)
    ).toBe(128000)
    const quote = await wallet.cashu.mint(cashuUrl, 512)
    expect(
      lightning('alice', 'payinvoice', '--force', '--json', quote.invoice)
        .status
    ).toBe('SUCCEEDED')
    await wallet.cashu.resume(quote.id)
    const source = (await wallet.cashu.notes()).find(
      n => n.amount === 512000 && n.status === 'ready'
    )!
    const toLnurl = await transfers.prepare(
      'cashu',
      [source.id],
      'lnurlcash',
      lnurlUrl,
      200000
    )
    const payment = (await wallet.cashu.state()).operations.find(
      o => o.id === toLnurl.paymentId
    )!
    expect(payment.inputFee).toBeGreaterThan(0)
    expect(payment.maximumDebit).toBeGreaterThan(200)
    loseMelt = true
    await expect(transfers.confirm(toLnurl.id)).rejects.toThrow(
      'lost melt response'
    )
    const backup = await vault.backup()
    vault = await makeVault()
    wallet = new Bearlett(vault, host)
    await wallet.cashu.enable(phrase, false)
    await vault.restore(backup, password)
    transfers = new Transfers(vault, wallet.cashu)
    await until(async () => {
      await transfers.resume(toLnurl.id)
      return (
        (await transfers.list()).find(t => t.id === toLnurl.id)?.phase ===
        'complete'
      )
    })
    expect(
      (await vault.notes()).find(n => n.id === toLnurl.targetId)?.amount
    ).toBe(199000)
    expect(
      (await wallet.cashu.state()).operations.find(o => o.id === payment.id)
        ?.phase
    ).toBe('complete')
    expect(
      (await wallet.cashu.notes()).some(
        n => n.status === 'ready' && n.amount > 0 && n.amount < 512000
      )
    ).toBe(true)
    expect(melts).toBe(1)
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

import {expect, it} from 'vitest'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {Vault} from '../../src/napplet/vault'
import {CashuEngine} from '../../src/napplet/cashu/engine'
import {TestMint, testInvoice} from '../../src/napplet/cashu/fixture'

// Isolated audit reproductions, not release acceptance tests. Each assertion
// documents current undesirable behavior. No network or real funds are used.
const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const otherPhrase =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const password = 'isolated audit password'

async function makeVault(seed = phrase): Promise<Vault> {
  const data = new Map<string, string>()
  const vault = new Vault({
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value)
    },
    keys: async () => [...data.keys()]
  })
  await vault.create(password, seed)
  return vault
}

it('REPRO F01: paid status without change completes and loses local change accounting', async () => {
  const vault = await makeVault()
  const mint = new TestMint()
  const engine = new CashuEngine(vault, mint)
  await engine.enable(phrase, false)
  await engine.receive(mint.token())
  const source = (await engine.notes()).find(n => n.status === 'ready')!
  const payment = await engine.preparePayment([source.id], testInvoice(10))
  mint.lost = 'melt'
  await expect(engine.pay(payment.id)).rejects.toThrow('Response lost')
  const normal = mint.request.bind(mint)
  mint.request = async request => {
    const response = await normal(request)
    if (request.operation === 'meltQuoteState') {
      const body = JSON.parse(response.body)
      delete body.change
      response.body = JSON.stringify(body)
    }
    return response
  }
  await engine.resume(payment.id)
  const state = await engine.state()
  expect(state.operations.find(op => op.id === payment.id)?.phase).toBe(
    'complete'
  )
  expect(state.assets.filter(a => a.note.status === 'ready')).toHaveLength(0)
  expect(mint.calls.filter(call => call.operation === 'melt')).toHaveLength(1)
  // The fixture actually issued 21 sats of change; no NUT-09 fallback ran.
  expect(mint.quotes.get(String(payment.quote!.quote))!.change).toHaveLength(3)
})

it('REPRO F02: deleting the entire Cashu metadata item is not detected on import', async () => {
  const source = await makeVault()
  const engine = new CashuEngine(source, new TestMint())
  await engine.enable(phrase, false)
  await engine.receive(
    engine.host instanceof TestMint ? engine.host.token() : ''
  )
  const backup = JSON.parse(await source.backup())
  delete backup.metadata['cashu-v1']
  const target = await makeVault()
  await expect(target.restore(JSON.stringify(backup), password)).resolves.toBe(
    0
  )
  expect(await target.meta('cashu-v1')).toBeNull()
})

it('REPRO F03: a foreign seed backup imports when destination Cashu is not enabled', async () => {
  const source = await makeVault()
  const engine = new CashuEngine(source, new TestMint())
  await engine.enable(phrase, false)
  const target = await makeVault(otherPhrase)
  await target.restore(await source.backup(), password)
  const restored = new CashuEngine(target, new TestMint())
  expect((await restored.state()).seed).toBe((await engine.state()).seed)
  expect(await target.meta('cash')).not.toEqual(await source.meta('cash'))
})

it('REPRO F04: a reserved empty range hides later issued outputs from seed recovery', async () => {
  const source = await makeVault()
  const mint = new TestMint()
  const engine = new CashuEngine(source, mint)
  await engine.enable(phrase, false)
  const state = await engine.state()
  state.counters[mint.id] = 100 // Durable reservation abandoned before mint dispatch.
  await engine.save(state)
  await engine.receive(mint.token())
  expect((await engine.notes()).some(n => n.status === 'ready')).toBe(true)
  const recovered = new CashuEngine(await makeVault(), mint)
  await recovered.enable(phrase, true)
  expect(await recovered.recover(mint.url)).toBe(0)
  expect((await recovered.state()).scanned).toContain(mint.url)
  expect((await recovered.state()).counters[mint.id] ?? 0).toBe(0)
})

it('REPRO F00: official installed shim resolves a failed Kehto storage acknowledgement', async () => {
  const listeners: ((event: unknown) => void)[] = []
  const parent = {
    postMessage(request: {type: string; id: string}): void {
      queueMicrotask(() => {
        const event = {
          source: parent,
          data: {type: request.type + '.result', id: request.id, ok: false}
        }
        listeners.forEach(listener => listener(event))
      })
    }
  }
  const fakeWindow = {
    parent,
    addEventListener(_type: string, listener: (event: unknown) => void): void {
      listeners.push(listener)
    },
    removeEventListener(): void {}
  }
  const context = {
    window: fakeWindow,
    crypto,
    console,
    // Timers are irrelevant: this test delivers an immediate correlated reply.
    setTimeout: (): number => 0,
    clearTimeout: (): void => {}
  }
  const source = readFileSync(
    new URL(
      '../../node_modules/@napplet/shim/dist/prelude.global.js',
      import.meta.url
    ),
    'utf8'
  )
  const api = runInNewContext(
    source + '\nNappletShimPrelude.install({domains:["storage"]});',
    context
  )
  await expect(
    api.storage.setItem('journal', 'test ciphertext')
  ).resolves.toBeUndefined()
})

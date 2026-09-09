import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Vault} from '../vault'
import {CashuEngine, decodeCashu} from './engine'
import {deserializeProofs, sumProofs} from '@cashu/cashu-ts'
import {TestMint, testInvoice} from './fixture'

const phrase =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const password = 'a long fixture password'
let vault: Vault, engine: CashuEngine, mint: TestMint, data: Map<string, string>
beforeEach(async () => {
  data = new Map()
  vault = new Vault({
    getItem: async k => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v)
    },
    keys: async () => [...data.keys()]
  })
  await vault.create(password, phrase)
  mint = new TestMint()
  engine = new CashuEngine(vault, mint)
  await engine.enable(phrase, false)
})
const ready = async () =>
  (await engine.notes()).filter(n => n.status === 'ready')
const recoveredEngine = async () => {
  const records = new Map<string, string>()
  const target = new Vault({
    getItem: async key => records.get(key) ?? null,
    setItem: async (key, value) => {
      records.set(key, value)
    },
    keys: async () => [...records.keys()]
  })
  await target.create(password, phrase)
  const restored = new CashuEngine(target, mint)
  await restored.enable(phrase, true)
  return restored
}
describe('Cashu durable ownership', () => {
  it('quarantines change recovered from a submitted payment after full restore', async () => {
    await engine.receive(mint.token())
    const op = await engine.preparePayment(
      [(await ready())[0].id],
      testInvoice(10)
    )
    mint.lost = 'melt'
    await expect(engine.pay(op.id)).rejects.toThrow('Response lost')
    const recovered = await recoveredEngine()
    await recovered.vault.restore(await vault.backup(), password)
    await recovered.resume(op.id)
    const state = await recovered.state()
    const completed = state.operations.find(value => value.id === op.id)!
    expect(completed.phase).toBe('complete')
    expect(completed.receivedIds.length).toBeGreaterThan(0)
    expect(
      state.assets
        .filter(a => completed.receivedIds.includes(a.note.id))
        .every(a => a.note.status === 'unverified')
    ).toBe(true)
    expect(
      (await recovered.exportRecovery(completed.receivedIds[0])).startsWith(
        'cashuB'
      )
    ).toBe(true)
  })
  it('blocks backups and a second engine while a wallet mutation is in flight', async () => {
    const normal = mint.request.bind(mint)
    let release!: () => void
    let started!: () => void
    const entering = new Promise<void>(resolve => {
      started = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let once = true
    mint.request = async request => {
      if (once) {
        once = false
        started()
        await held
      }
      return normal(request)
    }
    const receiving = engine.receive(mint.token())
    await entering
    try {
      await expect(vault.backup()).rejects.toThrow(/running|busy/i)
      await expect(
        new CashuEngine(vault, mint).mint(mint.url, 1)
      ).rejects.toThrow(/running|busy/i)
    } finally {
      release()
      await receiving
    }
  })
  it('never treats a legacy scanned flag as authority to reuse a recovered seed', async () => {
    const state = await engine.state()
    state.restored = true
    state.scanned = [mint.url]
    await engine.save(state)
    await expect(engine.receive(mint.token())).rejects.toThrow('fresh wallet')
    expect(mint.calls.filter(call => call.operation === 'swap')).toHaveLength(0)
  })
  it.each(['quote', 'duplicate', 'spent'] as const)(
    'keeps unsafe %s change responses pending',
    async fault => {
      await engine.receive(mint.token())
      const op = await engine.preparePayment(
        [(await ready())[0].id],
        testInvoice(10)
      )
      mint.lost = 'melt'
      await expect(engine.pay(op.id)).rejects.toThrow('Response lost')
      const normal = mint.request.bind(mint)
      mint.request = async request => {
        const response = await normal(request)
        const body = JSON.parse(response.body)
        if (request.operation === 'meltQuoteState') {
          if (fault === 'quote') body.quote = 'another-quote'
          if (fault === 'duplicate') delete body.change
        }
        if (fault === 'duplicate' && request.operation === 'restore') {
          body.outputs.push(body.outputs[0])
          body.signatures.push(body.signatures[0])
        }
        if (fault === 'spent' && request.operation === 'checkstate')
          body.states.forEach((state: {state: string}) => {
            state.state = 'SPENT'
          })
        response.body = JSON.stringify(body)
        return response
      }
      await expect(engine.resume(op.id)).rejects.toThrow()
      expect(
        (await engine.state()).operations.find(value => value.id === op.id)
          ?.phase
      ).toBe('submitted')
      expect(mint.calls.filter(call => call.operation === 'melt')).toHaveLength(
        1
      )
    }
  )
  it('does not dispatch an old-session swap after locking during a mint response', async () => {
    const normal = mint.request.bind(mint)
    let changed = false
    mint.request = async request => {
      const response = await normal(request)
      if (!changed) {
        changed = true
        vault.lock()
        await vault.unlock(password)
      }
      return response
    }
    await expect(engine.receive(mint.token())).rejects.toThrow(/session|lock/i)
    expect(mint.calls.filter(call => call.operation === 'swap')).toHaveLength(0)
  })
  it('moves recovered proofs to a fresh seed and invalidates the old bearer copies at the mint', async () => {
    await engine.receive(mint.token())
    const recovered = await recoveredEngine()
    await recovered.recover(mint.url)
    const old = (await recovered.state()).assets[0]
    const token = await recovered.exportRecovery(old.note.id)
    expect((await recovered.notes())[0].status).toBe('shared')
    const records = new Map<string, string>()
    const fresh = new Vault({
      getItem: async k => records.get(k) ?? null,
      setItem: async (k, v) => {
        records.set(k, v)
      },
      keys: async () => [...records.keys()]
    })
    const freshPhrase =
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    await fresh.create(password, freshPhrase)
    const recipient = new CashuEngine(fresh, mint)
    await recipient.enable(freshPhrase, false)
    await recipient.receive(token)
    expect(
      (await recipient.notes())
        .filter(n => n.status === 'ready')
        .map(n => n.amount)
    ).toEqual([32000])
    for (const proof of deserializeProofs(old.proofs))
      expect(mint.spent.has(proof.secret)).toBe(true)
  })
  it('receives real blind signatures and reserves a cashuB token before exposing it', async () => {
    await engine.receive(mint.token())
    expect((await ready()).map(n => n.amount)).toEqual([32000])
    const token = await engine.share((await ready())[0].id)
    expect(token.startsWith('cashuB')).toBe(true)
    expect(sumProofs(decodeCashu(token)[0].proofs).toNumber()).toBe(32)
    expect(await ready()).toHaveLength(0)
    expect([...data.values()].join('')).not.toContain(phrase)
    for (const p of deserializeProofs((await engine.state()).assets[1].proofs))
      expect([...data.values()].join('')).not.toContain(p.secret)
  })
  it('recovers a committed swap after losing its response without sending another swap', async () => {
    mint.lost = 'swap'
    await expect(engine.receive(mint.token())).rejects.toThrow('Response lost')
    expect(await ready()).toHaveLength(0)
    engine = new CashuEngine(vault, mint)
    await engine.resume((await engine.state()).operations[0].id)
    expect((await ready())[0].amount).toBe(32000)
    expect(mint.calls.filter(c => c.operation === 'swap')).toHaveLength(1)
    await engine.resume((await engine.state()).operations[0].id)
    expect(await ready()).toHaveLength(1)
  })
  it('splits and combines without duplicating unselected proofs', async () => {
    await engine.receive(mint.token())
    await engine.transform([(await ready())[0].id], 10)
    expect((await ready()).map(n => n.amount).sort((a, b) => a - b)).toEqual([
      10000, 22000
    ])
    await engine.transform((await ready()).map(n => n.id))
    expect((await ready()).map(n => n.amount)).toEqual([32000])
  })
  it('keeps exact change and reconciles a paid melt after response loss', async () => {
    await engine.receive(mint.token())
    const op = await engine.preparePayment(
      [(await ready())[0].id],
      testInvoice(10)
    )
    expect(op.maximumDebit).toBe(12)
    expect(await ready()).toHaveLength(0)
    mint.lost = 'melt'
    await expect(engine.pay(op.id)).rejects.toThrow('Response lost')
    engine = new CashuEngine(vault, mint)
    await engine.resume(op.id)
    expect((await ready()).map(n => n.amount)).toEqual([21000])
    await expect(engine.pay(op.id)).rejects.toThrow('not awaiting confirmation')
    expect(mint.calls.filter(c => c.operation === 'melt')).toHaveLength(1)
  })
  it('restores exact blank outputs when a paid quote omits its change', async () => {
    await engine.receive(mint.token())
    const op = await engine.preparePayment(
      [(await ready())[0].id],
      testInvoice(10)
    )
    mint.lost = 'melt'
    await expect(engine.pay(op.id)).rejects.toThrow('Response lost')
    const normal = mint.request.bind(mint)
    mint.request = async request => {
      const response = await normal(request)
      if (request.operation === 'meltQuoteState') {
        const quote = JSON.parse(response.body)
        delete quote.change
        response.body = JSON.stringify(quote)
      }
      return response
    }
    await engine.resume(op.id)
    expect((await ready()).map(n => n.amount)).toEqual([21000])
    const restore = mint.calls.find(c => c.operation === 'restore')!
    const melt = mint.calls.find(c => c.operation === 'melt')!
    expect(JSON.parse(restore.body!).outputs).toEqual(
      JSON.parse(melt.body!).outputs
    )
    expect(mint.calls.filter(c => c.operation === 'melt')).toHaveLength(1)
  })
  it.each(['pay', 'resume'] as const)(
    'keeps %s pending when restored change cannot cover the agreed minimum',
    async path => {
      await engine.receive(mint.token())
      const op = await engine.preparePayment(
        [(await ready())[0].id],
        testInvoice(10)
      )
      const normal = mint.request.bind(mint)
      mint.request = async request => {
        const response = await normal(request)
        if (['melt', 'meltQuoteState'].includes(request.operation)) {
          const quote = JSON.parse(response.body)
          delete quote.change
          response.body = JSON.stringify(quote)
        }
        if (request.operation === 'restore')
          response.body = JSON.stringify({outputs: [], signatures: []})
        return response
      }
      if (path === 'resume') {
        mint.lost = 'melt'
        await expect(engine.pay(op.id)).rejects.toThrow('Response lost')
      }
      await expect(engine[path](op.id)).rejects.toThrow('change')
      expect(
        (await engine.state()).operations.find(o => o.id === op.id)?.phase
      ).toBe('submitted')
      expect(await ready()).toHaveLength(0)
      expect(mint.calls.filter(c => c.operation === 'melt')).toHaveLength(1)
      mint.request = normal
      await engine.resume(op.id)
      expect((await ready()).map(n => n.amount)).toEqual([21000])
      expect(mint.calls.filter(c => c.operation === 'melt')).toHaveLength(1)
    }
  )
  it('requires the routing reserve before reserving source notes', async () => {
    await engine.receive(mint.token())
    await expect(
      engine.preparePayment([(await ready())[0].id], testInvoice(31))
    ).rejects.toThrow('do not cover')
    expect(await ready()).toHaveLength(1)
    expect((await engine.state()).operations).toHaveLength(1)
  })
  it('restores funded outputs after a lost mint response', async () => {
    const op = await engine.mint(mint.url, 21)
    mint.quotes.get(String(op.quote!.quote))!.state = 'PAID'
    mint.lost = 'mint'
    await expect(engine.resume(op.id)).rejects.toThrow('Response lost')
    await engine.resume(op.id)
    expect((await ready()).map(n => n.amount)).toEqual([21000])
    expect(mint.calls.filter(c => c.operation === 'mint')).toHaveLength(1)
  })
  it('rejects duplicate imports and expired invoices', async () => {
    const token = mint.token()
    await engine.receive(token)
    await expect(engine.receive(token)).rejects.toThrow('already recorded')
    await expect(
      engine.preparePayment([(await ready())[0].id], testInvoice(10, 1))
    ).rejects.toThrow('expired')
  })
  it('replays the exact swap after disconnecting before submission', async () => {
    mint.before = 'swap'
    await expect(engine.receive(mint.token())).rejects.toThrow(
      'before mint mutation'
    )
    const saved = await engine.state()
    await engine.resume(saved.operations[0].id)
    const calls = mint.calls.filter(c => c.operation === 'swap')
    expect(calls[1].body).toBe(calls[0].body)
    expect((await engine.state()).counters).toEqual(saved.counters)
    expect((await ready())[0].amount).toBe(32000)
  })
  it('reuses prepared mint outputs after an interruption before issuance', async () => {
    const op = await engine.mint(mint.url, 21)
    mint.quotes.get(String(op.quote!.quote))!.state = 'PAID'
    mint.before = 'mint'
    await expect(engine.resume(op.id)).rejects.toThrow('before mint mutation')
    const counters = (await engine.state()).counters
    await engine.resume(op.id)
    expect((await ready())[0].amount).toBe(21000)
    const calls = mint.calls.filter(c => c.operation === 'mint')
    expect(calls[1].body).toBe(calls[0].body)
    expect((await engine.state()).counters).toEqual(counters)
  })
  it('accounts for mint input fees when receiving and paying', async () => {
    mint = new TestMint(100)
    engine = new CashuEngine(vault, mint)
    await engine.receive(mint.token())
    expect((await ready())[0].amount).toBe(31000)
    const op = await engine.preparePayment(
      [(await ready())[0].id],
      testInvoice(10)
    )
    expect(op.inputFee).toBe(1)
    expect(op.maximumDebit).toBe(13)
    await engine.pay(op.id)
    expect((await ready())[0].amount).toBe(19000)
  })
  it('restores proofs without treating a seed scan as authority to reuse the writer seed', async () => {
    await engine.receive(mint.token())
    const old = (await engine.state()).counters
    const data = new Map<string, string>()
    const recovered = new Vault({
      getItem: async k => data.get(k) ?? null,
      setItem: async (k, v) => {
        data.set(k, v)
      },
      keys: async () => [...data.keys()]
    })
    await recovered.create(password, phrase)
    engine = new CashuEngine(recovered, mint)
    await engine.enable(phrase, true)
    expect(await engine.recover(mint.url)).toBeGreaterThan(0)
    expect((await engine.state()).counters[mint.id]).toBeGreaterThanOrEqual(
      old[mint.id]
    )
    expect((await engine.notes())[0].amount).toBe(32000)
    expect((await engine.state()).scanned).not.toContain(mint.url)
    await expect(engine.refresh((await engine.notes())[0].id)).rejects.toThrow(
      'fresh wallet'
    )
    expect(await ready()).toHaveLength(0)
    expect(mint.calls.filter(c => c.operation === 'swap')).toHaveLength(1)
  })
  it('finds outputs beyond an abandoned empty reservation', async () => {
    const reserved = await engine.state()
    reserved.counters[mint.id] = 100
    await engine.save(reserved)
    await engine.receive(mint.token())
    const recovered = await recoveredEngine()
    expect(await recovered.recover(mint.url)).toBeGreaterThan(0)
    const snapshot = await recovered.state()
    expect(snapshot.assets.map(a => a.note.amount)).toEqual([32000])
    expect(snapshot.counters[mint.id]).toBeGreaterThan(100)
    expect(snapshot.scanned).not.toContain(mint.url)
  })
  it('scans at least the known reserved counter range before applying the gap limit', async () => {
    const reserved = await engine.state()
    reserved.counters[mint.id] = 500
    await engine.save(reserved)
    await engine.receive(mint.token())
    const recovered = await recoveredEngine()
    const snapshot = await recovered.state()
    snapshot.counters[mint.id] = 501
    await recovered.save(snapshot)
    expect(await recovered.recover(mint.url)).toBeGreaterThan(0)
    expect((await recovered.state()).counters[mint.id]).toBeGreaterThanOrEqual(
      501
    )
  })
  it('can explicitly continue recovery beyond the default gap without granting spend access', async () => {
    const reserved = await engine.state()
    reserved.counters[mint.id] = 500
    await engine.save(reserved)
    await engine.receive(mint.token())
    const recovered = await recoveredEngine()
    expect(await recovered.recover(mint.url)).toBe(0)
    expect(
      await recovered.recover(mint.url, {start: 300, gapLimit: 400, limit: 800})
    ).toBeGreaterThan(0)
    expect((await recovered.state()).scanned).not.toContain(mint.url)
    expect((await recovered.state()).restored).toBe(true)
  })
  it.each([
    {start: -1},
    {gapLimit: 0},
    {limit: 1000001},
    {start: 999900, limit: 200}
  ])(
    'rejects unsafe recovery bounds %j before contacting the mint',
    async options => {
      const recovered = await recoveredEngine()
      await expect(recovered.recover(mint.url, options)).rejects.toThrow(
        'range'
      )
      expect(mint.calls).toHaveLength(0)
    }
  )
  it('keeps spent restored outputs out of the balance', async () => {
    mint.lost = 'swap'
    await expect(engine.receive(mint.token())).rejects.toThrow()
    const op = (await engine.state()).operations[0]
    const normal = mint.request.bind(mint)
    mint.request = async request => {
      const response = await normal(request)
      if (request.operation === 'checkstate')
        response.body = JSON.stringify({
          states: JSON.parse(request.body!).Ys.map((Y: string) => ({
            Y,
            state: 'SPENT'
          }))
        })
      return response
    }
    await expect(engine.resume(op.id)).rejects.toThrow('spent or pending')
    expect(await ready()).toHaveLength(0)
  })
  it('blocks spending after a torn backup import and resumes the same backup idempotently', async () => {
    await engine.receive(mint.token())
    const backup = await vault.backup(),
      data = new Map<string, string>()
    const target = new Vault({
      getItem: async k => data.get(k) ?? null,
      setItem: async (k, v) => {
        data.set(k, v)
      },
      keys: async () => [...data.keys()]
    })
    await target.create(password, phrase)
    const write = target.setMeta.bind(target)
    let fail = true
    vi.spyOn(target, 'setMeta').mockImplementation(async (key, value) => {
      if (key === 'cashu-v1' && fail) {
        fail = false
        throw new Error('Storage interrupted')
      }
      await write(key, value)
    })
    await expect(target.restore(backup, password)).rejects.toThrow(
      'Storage interrupted'
    )
    await expect(target.assertReady()).rejects.toThrow('same backup')
    await target.restore(backup, password)
    await expect(target.assertReady()).resolves.toBeUndefined()
    const recovered = new CashuEngine(target, mint)
    expect(
      (await recovered.notes()).filter(n => n.status === 'unverified')
    ).toHaveLength(1)
    expect((await recovered.state()).counters).toEqual(
      (await engine.state()).counters
    )
  })
})

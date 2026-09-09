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
describe('Cashu durable ownership', () => {
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
  it('restores deterministic proofs and advances counters before generating replacements', async () => {
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
    await engine.refresh((await engine.notes())[0].id)
    expect((await ready())[0].amount).toBe(32000)
    expect((await engine.state()).counters[mint.id]).toBeGreaterThan(
      old[mint.id]
    )
  })
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

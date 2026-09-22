import {describe, expect, it} from 'vitest'
import {Vault} from './vault'
import {
  emptySessionDraft,
  parseSessionDraft,
  resumeTab,
  spendableLine,
  spendableMints,
  waitingDraft,
  waitingLabel,
  SESSION_DRAFT_KEY
} from './bar'

const password = 'a sufficiently long test password'

describe('session draft', () => {
  it('keeps a payment and refuses a draft it cannot prove', () => {
    const draft = {
      ...emptySessionDraft(),
      tab: 'pay',
      invoice: 'lnbc210n1qqqq'
    }
    expect(parseSessionDraft(draft)).toEqual(draft)
    expect(waitingDraft(draft)).toBe(true)
    expect(resumeTab(draft)).toBe('pay')
    expect(waitingLabel(draft)).toBe('Payment waiting')
    expect(parseSessionDraft({...draft, tab: 'nope'})).toBeNull()
    expect(parseSessionDraft({...draft, invoice: 12})).toBeNull()
    expect(waitingDraft(emptySessionDraft())).toBe(false)
    expect(waitingLabel(emptySessionDraft())).toBe('')
  })

  it('names the task without repeating the secret', () => {
    const receive = {
      ...emptySessionDraft(),
      tab: 'receive',
      receive: 'https://mint.example/withdraw?k1=secret'
    }
    expect(waitingLabel(receive)).toBe('Note waiting to be received')
    expect(waitingLabel(receive)).not.toContain('secret')
    const funding = {
      ...emptySessionDraft(),
      tab: 'mint',
      fundingInvoice: 'lnbc310n1qqqq'
    }
    expect(resumeTab(funding)).toBe('mint')
    expect(waitingLabel(funding)).toBe('Sats waiting to arrive')
    const handed = {...emptySessionDraft(), shared: 'https://mint.example/n'}
    expect(resumeTab(handed)).toBe('wallet')
    expect(waitingLabel(handed)).toBe('Note waiting to be handed over')
  })

  it('round-trips through a locked vault without writing the invoice in the clear', async () => {
    const data = new Map<string, string>()
    const vault = new Vault({
      getItem: async key => data.get(key) ?? null,
      setItem: async (key, value) => {
        data.set(key, value)
      },
      keys: async () => [...data.keys()]
    })
    await vault.create(password)
    const draft = {
      ...emptySessionDraft(),
      tab: 'pay' as const,
      invoice: 'lnbc210n1qqqq-secret-invoice'
    }
    await vault.setMeta(SESSION_DRAFT_KEY, draft)
    vault.lock()
    await vault.unlock(password)
    expect(parseSessionDraft(await vault.meta(SESSION_DRAFT_KEY))).toEqual(
      draft
    )
    const raw = [...data.values()].join('')
    expect(raw).not.toContain('lnbc210n1qqqq-secret-invoice')
    expect(raw).not.toContain(password)
  })
})

describe('spendable line', () => {
  it('shows the largest mint and does not add the others into it', () => {
    const rows = spendableMints([
      {mint: 'a.example', amount: 1_000_000, ready: true},
      {mint: 'b.example', amount: 5_000_000, ready: true},
      {mint: 'b.example', amount: 1_000, ready: false},
      {mint: 'a.example', amount: 2_000_000, ready: true}
    ])
    expect(rows.map(row => [row.mint, row.msat, row.notes])).toEqual([
      ['b.example', 5_000_000, 1],
      ['a.example', 3_000_000, 2]
    ])
    expect(spendableLine(rows)).toEqual({
      figure: '5,000 sats',
      detail: 'Largest of 2 mints'
    })
    expect(spendableLine(rows.slice(0, 1))).toEqual({
      figure: '5,000 sats',
      detail: 'b.example'
    })
    expect(spendableLine([])).toEqual({
      figure: '0 sats',
      detail: 'Nothing ready'
    })
  })
})

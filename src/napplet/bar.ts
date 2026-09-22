/**
 * The one Bearlett bar: what is ready to spend, and what is waiting.
 *
 * Pure data. The strip, the wallet, Notes and the collection all read this
 * so a phone can leave and come back to the same task.
 */

export const SESSION_DRAFT_KEY = 'session-draft'

const TABS = [
  'wallet',
  'receive',
  'pay',
  'mint',
  'backup',
  'recovery',
  'transfer',
  'mints',
  'activity',
  'settings',
  'device'
] as const

const LIMITS = {
  receive: 256_000,
  invoice: 16_000,
  paymentAddress: 2_000,
  paymentAmount: 32,
  fundingInvoice: 16_000,
  mint: 2_000,
  amount: 32,
  shared: 256_000
} as const

export type SessionDraft = {
  tab: string
  receive: string
  invoice: string
  paymentAddress: string
  paymentAmount: string
  fundingInvoice: string
  mint: string
  mintProtocol: 'lnurlcash' | 'cashu'
  amount: string
  shared: string
}

export const emptySessionDraft = (): SessionDraft => ({
  tab: 'wallet',
  receive: '',
  invoice: '',
  paymentAddress: '',
  paymentAmount: '',
  fundingInvoice: '',
  mint: '',
  mintProtocol: 'lnurlcash',
  amount: '',
  shared: ''
})

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null

/** Drop a draft the vault cannot prove. A bad draft never reopens a form. */
export function parseSessionDraft(value: unknown): SessionDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const receive = text(raw.receive, LIMITS.receive)
  const invoice = text(raw.invoice, LIMITS.invoice)
  const paymentAddress = text(raw.paymentAddress, LIMITS.paymentAddress)
  const paymentAmount = text(raw.paymentAmount, LIMITS.paymentAmount)
  const fundingInvoice = text(raw.fundingInvoice, LIMITS.fundingInvoice)
  const mint = text(raw.mint, LIMITS.mint)
  const amount = text(raw.amount, LIMITS.amount)
  const shared = text(raw.shared, LIMITS.shared)
  const tab = text(raw.tab, 32)
  if (
    receive === null ||
    invoice === null ||
    paymentAddress === null ||
    paymentAmount === null ||
    fundingInvoice === null ||
    mint === null ||
    amount === null ||
    shared === null ||
    tab === null ||
    !TABS.includes(tab as (typeof TABS)[number]) ||
    (raw.mintProtocol !== 'lnurlcash' && raw.mintProtocol !== 'cashu')
  )
    return null
  return {
    tab,
    receive,
    invoice,
    paymentAddress,
    paymentAmount,
    fundingInvoice,
    mint,
    mintProtocol: raw.mintProtocol,
    amount,
    shared
  }
}

/** A task worth putting back on screen. An empty form is not one. */
export function waitingDraft(draft: SessionDraft): boolean {
  return [
    draft.receive,
    draft.invoice,
    draft.paymentAddress,
    draft.fundingInvoice,
    draft.shared
  ].some(value => value.trim() !== '')
}

/** Where the waiting task lives. */
export function resumeTab(draft: SessionDraft): string {
  if (draft.shared.trim()) return 'wallet'
  if (draft.tab === 'mint' && draft.fundingInvoice.trim()) return 'mint'
  if (
    draft.tab === 'pay' &&
    (draft.invoice.trim() || draft.paymentAddress.trim())
  )
    return 'pay'
  if (draft.tab === 'receive' && draft.receive.trim()) return 'receive'
  if (draft.fundingInvoice.trim()) return 'mint'
  if (draft.invoice.trim() || draft.paymentAddress.trim()) return 'pay'
  if (draft.receive.trim()) return 'receive'
  return 'wallet'
}

/** The bar's waiting chip. No secret, no invoice, no token. */
export function waitingLabel(draft: SessionDraft): string {
  if (!waitingDraft(draft)) return ''
  const tab = resumeTab(draft)
  if (tab === 'mint') return 'Sats waiting to arrive'
  if (tab === 'pay') return 'Payment waiting'
  if (tab === 'receive') return 'Note waiting to be received'
  if (draft.shared.trim()) return 'Note waiting to be handed over'
  return 'Something waiting'
}

export type MintSpend = {
  mint: string
  msat: number
  notes: number
}

/** Ready notes, one row per mint, largest spendable mint first. */
export function spendableMints(
  notes: readonly {mint: string; amount: number; ready: boolean}[]
): MintSpend[] {
  const rows = new Map<string, MintSpend>()
  for (const note of notes) {
    if (!note.ready || !Number.isFinite(note.amount) || note.amount <= 0)
      continue
    const mint = note.mint.trim()
    if (!mint) continue
    const row = rows.get(mint) ?? {mint, msat: 0, notes: 0}
    row.msat += note.amount
    row.notes += 1
    rows.set(mint, row)
  }
  return [...rows.values()].sort(
    (a, b) => b.msat - a.msat || a.mint.localeCompare(b.mint)
  )
}

const formatSats = (msat: number): string =>
  (msat / 1000).toLocaleString('en-US', {maximumFractionDigits: 3})

/**
 * The number on the bar.
 *
 * One mint: that mint's ready sats. Several mints: the largest mint, named
 * as the largest, because the mints are not one balance.
 */
export function spendableLine(rows: readonly MintSpend[]): {
  figure: string
  detail: string
} {
  if (!rows.length) return {figure: '0 sats', detail: 'Nothing ready'}
  const top = rows[0]
  const figure = `${formatSats(top.msat)} sats`
  if (rows.length === 1) return {figure, detail: top.mint}
  return {figure, detail: `Largest of ${rows.length} mints`}
}

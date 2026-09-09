import {Wallet, requireIssuerUrl} from './wallet'
import type {Vault} from './vault'
import type {CashuEngine} from './cashu/engine'
import {
  fetchNoteInfo,
  NoteSpentError,
  NoteUnknownError,
  decodeBolt11AmountMsat,
  fetchPayRequest,
  applyMintFee,
  fetchInvoiceVerification,
  sameInvoice,
  verifyMeltPreimage
} from '../lnurlcash'
import {invoiceAmount} from './cashu/invoice'
import {mintUrl} from './cashu/transport'

export type Protocol = 'lnurlcash' | 'cashu'
export type Transfer = {
  id: string
  source: Protocol
  sourceIds: string[]
  target: Protocol
  mint: string
  amountMsat: number
  invoice?: string
  targetId?: string
  paymentId?: string
  phase: 'preparing' | 'quoted' | 'funding' | 'claiming' | 'complete'
  createdAt: number
  expectedTargetMsat?: number
  maximumDebitMsat?: number
  preparationFeeMsat?: number
  quoteExpiry?: number
}

/** Persist the linkage between independent mint and payment journals before sending value. */
export class Transfers {
  private running = false
  private lnurl: Wallet
  constructor(
    private vault: Vault,
    private cashu: CashuEngine
  ) {
    this.lnurl = new Wallet(vault)
  }
  async list(): Promise<Transfer[]> {
    return (await this.vault.meta<Transfer[]>('transfers-v1')) ?? []
  }
  private async save(t: Transfer): Promise<void> {
    const all = await this.list(),
      index = all.findIndex(x => x.id === t.id)
    if (index < 0) all.push(t)
    else all[index] = t
    await this.vault.setMeta('transfers-v1', all)
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.vault.assertReady()
    if (this.running) throw new Error('Another transfer is running.')
    this.running = true
    try {
      return await fn()
    } finally {
      this.running = false
    }
  }
  /** Create and bind the destination quote before preparing any source spend. */
  async prepare(
    source: Protocol,
    ids: string[],
    target: Protocol,
    mint: string,
    amountMsat: number
  ): Promise<Transfer> {
    return this.exclusive(async () => {
      if (
        !Number.isSafeInteger(amountMsat) ||
        amountMsat <= 0 ||
        amountMsat % 1000
      )
        throw new Error('Transfer amounts must be whole sats.')
      if (!ids.length)
        throw new Error('Select source notes in your collection.')
      const notes =
        source === 'cashu' ? await this.cashu.notes() : await this.vault.notes()
      const selected = ids.map(id => notes.find(n => n.id === id))
      if (
        selected.some(n => !n || n.status !== 'ready') ||
        new Set(
          selected.map(n =>
            source === 'cashu' ? mintUrl(n!.url) : new URL(n!.url).origin
          )
        ).size !== 1
      )
        throw new Error('Select available notes from one source mint.')
      const t: Transfer = {
        id: crypto.randomUUID(),
        source,
        sourceIds: ids,
        target,
        mint,
        amountMsat,
        phase: 'preparing',
        createdAt: Date.now()
      }
      t.expectedTargetMsat = amountMsat
      if (target === 'lnurlcash') {
        const info = await fetchPayRequest(mint)
        if (info.mintFee)
          t.expectedTargetMsat =
            Math.floor(applyMintFee(amountMsat, info.mintFee) / 1000) * 1000
      }
      await this.save(t)
      if (target === 'cashu') {
        const op = await this.cashu.mint(mint, amountMsat / 1000)
        t.targetId = op.id
        t.invoice = op.invoice
      } else {
        t.invoice = await this.lnurl.mint(mint, amountMsat)
        t.targetId = (await this.vault.notes()).find(
          n => n.invoice === t.invoice && n.invoiceType === 'funding'
        )!.id
      }
      await this.save(t)
      if (decodeBolt11AmountMsat(t.invoice!) !== amountMsat)
        throw new Error('Transfer quote amount mismatch.')
      invoiceAmount(t.invoice!)
      if (source === 'cashu') {
        const op = await this.cashu.preparePayment(ids, t.invoice!)
        t.paymentId = op.id
        t.maximumDebitMsat = op.maximumDebit! * 1000
        t.quoteExpiry = Number(op.quote!.expiry) * 1000
      } else {
        t.paymentId = await this.lnurl.preparePayment(ids, t.invoice!)
        const after = (await this.vault.notes())
          .filter(n => n.status === 'ready')
          .reduce((sum, n) => sum + n.amount, 0)
        const before = notes
          .filter(n => n.status === 'ready')
          .reduce((sum, n) => sum + n.amount, 0)
        t.preparationFeeMsat = Math.max(0, before - after)
        t.maximumDebitMsat = amountMsat + t.preparationFeeMsat
      }
      t.phase = 'quoted'
      await this.save(t)
      return t
    })
  }
  /** The confirmation transition is durable before dispatch; ambiguous calls are never resent. */
  async confirm(id: string): Promise<void> {
    await this.exclusive(async () => {
      const t = (await this.list()).find(t => t.id === id)
      if (!t || t.phase !== 'quoted' || !t.paymentId || !t.invoice)
        throw new Error('Transfer is not awaiting confirmation.')
      invoiceAmount(t.invoice)
      if (t.quoteExpiry && t.quoteExpiry <= Date.now())
        throw new Error('Source quote expired. Do not confirm this transfer.')
      t.phase = 'funding'
      await this.save(t)
      if (t.source === 'cashu') await this.cashu.pay(t.paymentId)
      else await this.lnurl.pay(t.paymentId, t.invoice)
    })
    await this.resume(id)
  }
  /** Reconcile both ends; an accepted request or missing note never proves completion alone. */
  async resume(id: string): Promise<void> {
    await this.exclusive(async () => {
      const t = (await this.list()).find(t => t.id === id)
      if (!t || !['funding', 'claiming'].includes(t.phase)) return
      if (t.source === 'cashu') {
        await this.cashu.resume(t.paymentId!)
        if (
          (await this.cashu.state()).operations.find(o => o.id === t.paymentId)
            ?.phase !== 'complete'
        )
          throw new Error('Source payment is awaiting settlement.')
      } else {
        const note = (await this.vault.notes()).find(n => n.id === t.paymentId)!
        let proven = false
        if (note.verifyUrl) {
          const proof = await fetchInvoiceVerification(
            requireIssuerUrl(note.verifyUrl, note.url)
          )
          if (!sameInvoice(proof.pr, t.invoice!))
            throw new Error('Source verification refers to another invoice.')
          if (!proof.settled)
            throw new Error('Source payment is awaiting settlement.')
          if (proof.preimage) {
            if (!verifyMeltPreimage(t.invoice!, proof.preimage))
              throw new Error('Source supplied an invalid payment preimage.')
            proven = true
            await this.vault.save({...note, proof: proof.preimage})
          }
        }
        if (!proven) {
          // LUD-21 may omit a preimage. Source absence is only provisional:
          // completion below still requires issuance of this exact destination invoice.
          try {
            await fetchNoteInfo(note.url)
            throw new Error('Source note is still outstanding or pending.')
          } catch (e) {
            if (
              !(e instanceof NoteSpentError) &&
              !(e instanceof NoteUnknownError)
            )
              throw e
          }
        }
      }
      t.phase = 'claiming'
      await this.save(t)
      if (t.target === 'cashu') {
        await this.cashu.resume(t.targetId!)
        const op = (await this.cashu.state()).operations.find(
          o => o.id === t.targetId
        )
        if (op?.phase !== 'complete' || !op.receivedIds.length)
          throw new Error('Destination proofs are not yet stored.')
      } else {
        await this.lnurl.refresh(t.targetId!)
        if (
          (await this.vault.notes()).find(n => n.id === t.targetId)?.status !==
          'ready'
        )
          throw new Error('Destination note is not yet available.')
      }
      if (t.source === 'lnurlcash') {
        const note = (await this.vault.notes()).find(n => n.id === t.paymentId)!
        await this.vault.save({
          ...note,
          status: 'spent',
          reason: 'Source consumed and destination bearer asset stored.'
        })
      }
      t.phase = 'complete'
      await this.save(t)
    })
  }
}

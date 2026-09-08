import {bytesToHex} from '@noble/hashes/utils.js'
import {
  resolveNoteInput,
  noteK1,
  noteDeclaredAmount,
  noteEndpointOf,
  withNewK1,
  fetchNoteInfo,
  hashK1,
  rotateNoteWithHash,
  splitNoteWithHash,
  mergeNotesWithHash,
  meltNote,
  decodeBolt11AmountMsat,
  isBolt11Invoice,
  resolveMintInput,
  resolveLnurlInput,
  fetchPayRequest,
  requireMintComment,
  requestInvoice,
  buildNoteUrl,
  NoteSpentError,
  NoteUnknownError
} from '../lnurlcash'
import {Vault} from './vault'
import type {Note} from './vault'

/** Restrict bearer disclosure to the HTTPS issuer selected by the user. */
export const requireIssuerUrl = (url: string, issuer: string): string => {
  const target = new URL(url)
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.origin !== new URL(issuer).origin
  ) {
    throw new Error('The mint returned an address outside its HTTPS origin.')
  }
  return target.toString()
}

const newNote = (url: string, amount: number, reason: string): Note => ({
  id: crypto.randomUUID(),
  url,
  amount,
  reason,
  status: 'pending',
  updatedAt: Date.now()
})
const secret = (): string =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

/** LNURLcash operations with encrypted recovery records written before mutations. */
export class Wallet {
  constructor(readonly vault: Vault) {}

  /** Keep the incoming note, then rotate after the user's receive confirmation. */
  async receive(input: string): Promise<void> {
    const url = resolveNoteInput(input.trim().replace(/^lightning:/i, ''))
    if (!url) throw new Error('Not an LNURLcash note.')
    requireIssuerUrl(url, url)
    if (
      (await this.vault.notes()).some(
        n =>
          noteK1(n.url) === noteK1(url) &&
          noteEndpointOf(n.url) === noteEndpointOf(url)
      )
    ) {
      throw new Error('This note is already in the wallet.')
    }
    const note = {
      ...newNote(
        url,
        noteDeclaredAmount(url) ?? 0,
        'Received; not yet rotated.'
      ),
      status: 'unverified' as const
    }
    await this.vault.save(note)
    await this.transform([note.id], 'rotate')
  }

  /** Reconcile a stored candidate without repeating any mutation. */
  async refresh(id: string): Promise<void> {
    const note = await this.find(id)
    try {
      const info = await fetchNoteInfo(note.url)
      requireIssuerUrl(info.callback, note.url)
      await this.vault.save({
        ...note,
        amount: info.maxWithdrawable,
        status: note.status === 'shared' ? 'shared' : 'ready',
        reason:
          'Confirmed outstanding by issuer. Rotate if another holder has a copy.',
        updatedAt: Date.now()
      })
    } catch (error) {
      if (
        error instanceof NoteSpentError ||
        error instanceof NoteUnknownError
      ) {
        await this.vault.save({
          ...note,
          status: 'spent',
          reason:
            'Not outstanding. This alone does not prove a payment settled.',
          updatedAt: Date.now()
        })
      } else throw error
    }
  }

  /** Rotate, split or combine; all candidate secrets survive an interrupted request. */
  async transform(
    ids: string[],
    action: 'rotate' | 'split' | 'combine',
    amount?: number
  ): Promise<void> {
    if (
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.length > 100 ||
      (action === 'rotate' && ids.length !== 1) ||
      (action === 'combine' && ids.length < 2)
    ) {
      throw new Error('Select the notes for this operation.')
    }
    const notes = await Promise.all(ids.map(id => this.find(id)))
    if (notes.some(n => ['spent', 'shared', 'pending'].includes(n.status))) {
      throw new Error(
        'Check unresolved notes before using them; shared notes cannot be spent here.'
      )
    }
    const infos = await Promise.all(notes.map(n => fetchNoteInfo(n.url)))
    const callback = requireIssuerUrl(infos[0].callback, notes[0].url)
    if (
      notes.some(
        (n, i) =>
          noteEndpointOf(n.url) !== noteEndpointOf(notes[0].url) ||
          requireIssuerUrl(infos[i].callback, n.url) !== callback
      )
    ) {
      throw new Error('Select notes from the same mint endpoint.')
    }
    const total = infos.reduce((sum, info) => sum + info.maxWithdrawable, 0)
    if (!Number.isSafeInteger(total) || total <= 0)
      throw new Error('Invalid mint amount.')
    if (
      action === 'split' &&
      (!Number.isSafeInteger(amount) || amount! <= 0 || amount! >= total)
    ) {
      throw new Error(
        'The split amount must be positive and smaller than the selected balance.'
      )
    }
    const outputs = (
      action === 'split' ? [amount!, total - amount!] : [total]
    ).map(value => ({
      ...newNote(
        withNewK1(notes[0].url, secret(), value),
        value,
        `${action}: recovery candidate; check online.`
      ),
      designId: notes[0].designId
    }))
    for (const output of outputs) await this.vault.save(output)
    for (const note of notes)
      await this.vault.save({
        ...note,
        status: 'pending',
        reason: `${action}: request may be in flight; check online.`,
        updatedAt: Date.now()
      })
    const k1s = notes.map(n => noteK1(n.url)!)
    const hashes = outputs.map(n => hashK1(noteK1(n.url)!))
    let signatures: string[]
    if (action === 'split') {
      const result = await splitNoteWithHash(
        callback,
        k1s,
        amount!,
        hashes[0],
        hashes[1]
      )
      signatures = [result.signature, result.changeSignature]
    } else {
      const result =
        action === 'rotate'
          ? await rotateNoteWithHash(callback, k1s[0], hashes[0])
          : await mergeNotesWithHash(callback, k1s, hashes[0])
      signatures = [result.signature]
    }
    // Keep every source even after confirmation. A failure at any write can be
    // reconciled by hash lookup; no output secret depends on a success response.
    for (const note of notes)
      await this.vault.save({
        ...note,
        status: 'spent',
        reason: `${action} accepted by issuer.`,
        updatedAt: Date.now()
      })
    for (const [index, output] of outputs.entries()) {
      await this.vault.save({
        ...output,
        url: withNewK1(
          output.url,
          noteK1(output.url)!,
          output.amount,
          signatures[index]
        )
      })
      await this.refresh(output.id)
    }
  }

  /** Submit a fixed-amount invoice; an accepted request is not settlement proof. */
  async pay(id: string, input: string): Promise<void> {
    const invoice = input.trim().replace(/^lightning:/i, '')
    const amount = decodeBolt11AmountMsat(invoice)
    if (!isBolt11Invoice(invoice) || !amount)
      throw new Error('Use a fixed-amount BOLT11 invoice.')
    const note = await this.find(id)
    if (note.status !== 'ready')
      throw new Error('Select a confirmed, unshared note.')
    const info = await fetchNoteInfo(note.url)
    const callback = requireIssuerUrl(info.callback, note.url)
    if (info.maxWithdrawable !== amount)
      throw new Error(
        'Invoice and note amounts must match. Split or combine first.'
      )
    await this.vault.save({
      ...note,
      status: 'pending',
      invoice,
      invoiceType: 'payment',
      reason:
        'Payment requested. Check status; never infer settlement from dispatch.',
      updatedAt: Date.now()
    })
    await meltNote(callback, noteK1(note.url)!, invoice)
  }

  /** Reserve the mint output before asking for its funding invoice. */
  async mint(input: string, amount: number): Promise<string> {
    const url = resolveMintInput(input) ?? resolveLnurlInput(input)
    if (!url) throw new Error('Enter a mint URL or Lightning address.')
    requireIssuerUrl(url, url)
    const info = await fetchPayRequest(url)
    requireMintComment(info)
    if (!info.withdrawLink)
      throw new Error('This service does not mint LNURLcash notes.')
    if (
      !Number.isSafeInteger(amount) ||
      amount < info.minSendable ||
      amount > info.maxSendable
    ) {
      throw new Error(
        `Mint amount must be between ${info.minSendable / 1000} and ${info.maxSendable / 1000} sats.`
      )
    }
    const endpoint = requireIssuerUrl(
      info.withdrawLink.replace(/^lnurlw:/i, 'https:'),
      url
    )
    const callback = requireIssuerUrl(info.callback, url)
    const k1 = secret()
    const note = newNote(
      buildNoteUrl(endpoint, k1, amount),
      amount,
      'Awaiting external invoice payment; check after paying.'
    )
    await this.vault.save(note)
    const quote = await requestInvoice(callback, amount, hashK1(k1))
    await this.vault.save({...note, invoice: quote.pr, invoiceType: 'funding'})
    return quote.pr
  }

  /** Record handover before displaying the bearer secret. */
  async share(id: string): Promise<string> {
    const note = await this.find(id)
    if (note.status !== 'ready')
      throw new Error('Only a confirmed note can be shared.')
    await this.vault.save({
      ...note,
      status: 'shared',
      reason: 'Handed over; excluded from spendable balance.',
      updatedAt: Date.now()
    })
    return note.url
  }

  private async find(id: string): Promise<Note> {
    const note = (await this.vault.notes()).find(n => n.id === id)
    if (!note) throw new Error('Note not found.')
    return note
  }
}

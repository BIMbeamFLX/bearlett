import {Wallet} from './wallet'
import {CashuEngine} from './cashu/engine'
import type {Vault, Note} from './vault'
import type {CashuHost} from './cashu/transport'

/** Present one wallet while keeping mint operations inside their own protocol adapter. */
export class Bearlett extends Wallet {
  readonly cashu: CashuEngine
  constructor(vault: Vault, host?: CashuHost, offline?: () => boolean) {
    super(vault)
    this.cashu = new CashuEngine(vault, host, offline)
  }
  /** Combine public note fields; Cashu proofs remain in their encrypted snapshot. */
  async notes(): Promise<Note[]> {
    return [...(await this.vault.notes()), ...(await this.cashu.notes())]
  }
  private async protocol(id: string): Promise<'cashu' | 'lnurlcash'> {
    return (await this.cashu.notes()).some(n => n.id === id)
      ? 'cashu'
      : 'lnurlcash'
  }
  /** Select one protocol per operation; cross-protocol movement uses an explicit transfer. */
  private async selectedProtocol(
    ids: string[]
  ): Promise<'cashu' | 'lnurlcash'> {
    const protocols = await Promise.all(ids.map(id => this.protocol(id)))
    if (!ids.length || new Set(protocols).size !== 1)
      throw new Error('Select notes of one protocol and mint.')
    return protocols[0]
  }
  async receive(input: string): Promise<void> {
    return /^(cashu:)?cashu[AB]/i.test(input.trim())
      ? this.cashu.receive(input)
      : super.receive(input)
  }
  async refresh(id: string): Promise<void> {
    return (await this.protocol(id)) === 'cashu'
      ? this.cashu.refresh(id)
      : super.refresh(id)
  }
  async transform(
    ids: string[],
    action: 'rotate' | 'split' | 'combine',
    amount?: number
  ): Promise<string[]> {
    if ((await this.selectedProtocol(ids)) === 'cashu') {
      await this.cashu.transform(
        ids,
        action === 'split' ? amount! / 1000 : undefined
      )
      return (await this.cashu.state()).operations.at(-1)?.receivedIds ?? []
    }
    return super.transform(ids, action, amount)
  }
  async share(
    id: string,
    format: 'url' | 'lnurl' | 'lnurlw' | 'claim' = 'url'
  ): Promise<string> {
    return (await this.protocol(id)) === 'cashu'
      ? this.cashu.share(id)
      : super.share(id, format)
  }
  /** Move quarantined recovery assets to a fresh wallet without reusing its old seed. */
  async exportRecovery(id: string): Promise<string> {
    return (await this.protocol(id)) === 'cashu'
      ? this.cashu.exportRecovery(id)
      : super.exportRecovery(id)
  }
  async preparePayment(ids: string[], invoice: string): Promise<string> {
    if ((await this.selectedProtocol(ids)) !== 'cashu')
      return super.preparePayment(ids, invoice)
    const op = await this.cashu.preparePayment(ids, invoice)
    return op.id
  }
  async pay(id: string, invoice: string): Promise<void> {
    const state =
      await this.vault.meta<import('./cashu/state').CashuState>('cashu-v1')
    const op = state?.operations.find(o => o.id === id && o.kind === 'melt')
    if (op) {
      if (op.invoice !== invoice)
        throw new Error('Invoice changed. Prepare this payment again.')
      return this.cashu.pay(id)
    }
    if ((await this.protocol(id)) === 'cashu')
      throw new Error('Prepare the Cashu payment and review its fees first.')
    return super.pay(id, invoice)
  }
  async annotate(id: string, label: string): Promise<void> {
    return (await this.protocol(id)) === 'cashu'
      ? this.cashu.annotate(id, {label})
      : super.annotate(id, label)
  }
  async mark(id: string, action: 'spent' | 'unspent' | 'hide'): Promise<void> {
    if ((await this.protocol(id)) !== 'cashu') return super.mark(id, action)
    if (action === 'hide') return this.cashu.annotate(id, {hidden: true})
    if (action === 'unspent') {
      const note = (await this.cashu.notes()).find(n => n.id === id)
      return note?.status === 'shared'
        ? this.cashu.reclaim(id)
        : this.cashu.refresh(id)
    }
    await this.cashu.share(id)
  }
  /** Keep design changes protocol-neutral and separate from bearer contents. */
  async design(id: string, designId: string): Promise<void> {
    if ((await this.protocol(id)) === 'cashu')
      return this.cashu.annotate(id, {designId})
    const note = (await this.vault.notes()).find(n => n.id === id)
    if (note) await this.vault.save({...note, designId})
  }
}

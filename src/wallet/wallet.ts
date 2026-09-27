// The wallet: LUD-25 flows over the spec core, the LNURL layer and two
// ports (network, storage). Every mint call that changes state is written
// to the operation journal before it is sent, so a crash or a lost answer
// never loses a note: a burn is retried as a replay, a mint or melt is
// settled by looking its note up.
import {bytesToHex, hexToBytes, sha256} from '../spec/bytes.ts'
import {verifyCertificate} from '../spec/certificate.ts'
import {PURPOSE, notePubkey, type Purpose} from '../spec/derivation.ts'
import {encodeCp1} from '../spec/encoding.ts'
import {
  bearerNote,
  checkSpend,
  decodeSpend,
  newPreimage
} from '../spec/notes.ts'
import {spendDomain} from '../spec/spend.ts'
import {ServiceError, TransportError, reason} from '../lnurl/errors.ts'
import {
  buildNoteLink,
  invoiceAmountMsat,
  type NoteLink
} from '../lnurl/links.ts'
import type {Net} from '../lnurl/net.ts'
import {
  canMint,
  fetchPayRequest,
  requestInvoice,
  type PayRequest
} from '../lnurl/pay.ts'
import {
  burn,
  fetchNoteInfo,
  melt,
  registerUsername,
  unregisterUsername,
  type Certificates,
  type NoteInfo
} from '../lnurl/withdraw.ts'
import {KeyRing, hostOf, spendDomainOfHost, type KeyRef} from './keys.ts'
import {selectNotes} from './select.ts'
import {legacyCandidates} from './legacy.ts'
import {
  ACTIVITY_LIMIT,
  emptyState,
  isWalletState,
  type Activity,
  type Hex,
  type Mint,
  type Note,
  type Operation,
  type Output,
  type SpendRef,
  type WalletState
} from './state.ts'
import {STATE_KEY, VAULT_KEY, type Store} from './store.ts'
import {
  isSealedVault,
  openJson,
  openMnemonic,
  sealJson,
  sealMnemonic,
  seedOf,
  stateKey
} from './vault.ts'

export type Ports = {net: Net; store: Store; now?: () => number}

export class UnknownMintError extends Error {
  readonly domain: string
  constructor(domain: string) {
    super(`${domain} is not one of your mints yet.`)
    this.name = 'UnknownMintError'
    this.domain = domain
  }
}

export class MintKeyChangedError extends Error {
  constructor(domain: string) {
    super(`${domain} now signs with a different key than it did before.`)
    this.name = 'MintKeyChangedError'
  }
}

type Burn = Extract<Operation, {kind: 'burn'}>
type Melt = Extract<Operation, {kind: 'melt'}>
type MintOp = Extract<Operation, {kind: 'mint'}>

const MAX_INDEX_RETRIES = 10
const cp1Of = (output: Output): string => encodeCp1(hexToBytes(output.q))
const id = (): string => crypto.randomUUID()

/** A bare domain names lnurl-mint's own identity, `_`. */
export const mintPayUrl = (input: string): string => {
  const text = input.trim()
  if (/^https?:\/\//i.test(text)) return text
  const host = text.replace(/\/.*$/, '').toLowerCase()
  const scheme = host.endsWith('.onion') ? 'http' : 'https'
  return `${scheme}://${host}/.well-known/lnurlp/_`
}

export class Wallet {
  private readonly listeners = new Set<() => void>()
  private saving: Promise<void> = Promise.resolve()

  private readonly ports: Ports
  private readonly keys: KeyRing
  private readonly sealKey: CryptoKey
  private state: WalletState

  private constructor(
    ports: Ports,
    keys: KeyRing,
    sealKey: CryptoKey,
    state: WalletState
  ) {
    this.ports = ports
    this.keys = keys
    this.sealKey = sealKey
    this.state = state
  }

  // ---- lifecycle ----

  static async exists(store: Store): Promise<boolean> {
    return (await store.get(VAULT_KEY)) !== null
  }

  /** Seals a new or restored seed phrase and opens its wallet. */
  static async create(
    ports: Ports,
    words: string,
    passphrase: string
  ): Promise<Wallet> {
    await ports.store.set(
      VAULT_KEY,
      JSON.stringify(await sealMnemonic(words, passphrase))
    )
    // any state here was sealed for another seed
    await ports.store.remove(STATE_KEY)
    return Wallet.open(ports, words)
  }

  static async unlock(ports: Ports, passphrase: string): Promise<Wallet> {
    const raw = await ports.store.get(VAULT_KEY)
    const vault = raw ? JSON.parse(raw) : null
    if (!isSealedVault(vault)) throw new Error('No wallet on this device.')
    return Wallet.open(ports, await openMnemonic(vault, passphrase))
  }

  /** The seed phrase, for a backup the user asked to see. */
  static async revealWords(store: Store, passphrase: string): Promise<string> {
    const raw = await store.get(VAULT_KEY)
    const vault = raw ? JSON.parse(raw) : null
    if (!isSealedVault(vault)) throw new Error('No wallet on this device.')
    return openMnemonic(vault, passphrase)
  }

  private static async open(ports: Ports, words: string): Promise<Wallet> {
    const seed = seedOf(words)
    const key = await stateKey(seed)
    const sealed = await ports.store.get(STATE_KEY)
    let state = emptyState()
    if (sealed) {
      const opened = await openJson(key, sealed)
      if (isWalletState(opened)) state = opened
    }
    return new Wallet(ports, new KeyRing(seed), key, state)
  }

  // ---- state ----

  get snapshot(): Readonly<WalletState> {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private now(): number {
    return (this.ports.now ?? Date.now)()
  }

  /** Applies a change, tells the UI, and waits until it is stored. */
  private async commit(change: (state: WalletState) => void): Promise<void> {
    change(this.state)
    for (const listener of this.listeners) listener()
    const state = JSON.parse(JSON.stringify(this.state))
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await this.ports.store.set(
          STATE_KEY,
          await sealJson(this.sealKey, state)
        )
      })
    await this.saving
  }

  private log(state: WalletState, entry: Omit<Activity, 'id' | 'at'>): void {
    state.activity.unshift({id: id(), at: this.now(), ...entry})
    state.activity.length = Math.min(state.activity.length, ACTIVITY_LIMIT)
  }

  private get net(): Net {
    if (this.state.settings.offline)
      return {
        get: async () => {
          throw new TransportError('Offline mode is on. Nothing was sent.')
        }
      }
    return this.ports.net
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.commit(state => {
      state.settings.offline = offline
    })
  }

  async setGapLimit(gapLimit: number): Promise<void> {
    if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > 500)
      throw new Error('The gap limit is a whole number from 1 to 500.')
    await this.commit(state => {
      state.settings.gapLimit = gapLimit
    })
  }

  // ---- reading ----

  notes(filter: Partial<Pick<Note, 'mint' | 'role' | 'status'>> = {}): Note[] {
    return Object.values(this.state.notes).filter(
      note =>
        (filter.mint === undefined || note.mint === filter.mint) &&
        (filter.role === undefined || note.role === filter.role) &&
        (filter.status === undefined || note.status === filter.status)
    )
  }

  balanceMsat(mint?: string): number {
    return this.notes({mint, role: 'own', status: 'live'}).reduce(
      (sum, note) => sum + note.amountMsat,
      0
    )
  }

  mint(domain: string): Mint {
    const mint = this.state.mints[domain]
    if (!mint) throw new UnknownMintError(domain)
    return mint
  }

  /** The note link for a note this wallet made to hand out. */
  noteLink(q: Hex): string {
    const note = this.state.notes[q]
    if (!note || note.spend.kind === 'key')
      throw new Error('Only bearer notes are handed out as links.')
    return buildNoteLink({
      endpoint: this.mint(note.mint).withdrawLink,
      k1: this.spendOf(note),
      amountMsat: note.amountMsat,
      c: note.c
    })
  }

  // ---- payees ----

  /** A payRequest to pay, through this wallet's network and offline guard. */
  async payRequest(url: string): Promise<PayRequest> {
    return fetchPayRequest(this.net, url)
  }

  /** A plain LUD-06 invoice from a payee, to melt into. */
  async invoiceFor(
    pay: PayRequest,
    amountMsat: number,
    comment?: string
  ): Promise<string> {
    return (await requestInvoice(this.net, pay, amountMsat, comment)).pr
  }

  /** The mint an internal transfer to this payee would go through, if this wallet has it. */
  transferMint(pay: PayRequest): string | null {
    if (!pay.cpub || !pay.withdrawLink) return null
    const host = hostOf(pay.withdrawLink)
    return this.state.mints[host] ? host : null
  }

  // ---- mints ----

  /** Adds a mint by its payRequest (a domain, Lightning Address or LNURL). */
  async addMint(input: string, payUrl = mintPayUrl(input)): Promise<Mint> {
    const pay = await fetchPayRequest(this.net, payUrl)
    if (!canMint(pay))
      throw new ServiceError('This service does not mint LNURLcash notes.')
    return this.rememberMint(pay.withdrawLink!, {
      payUrl,
      fee: pay.mintFee,
      name: pay.identifier
    })
  }

  /** A mint known only from a note it issued: minting there needs its payRequest. */
  async trustMintOf(endpoint: string): Promise<Mint> {
    return this.rememberMint(endpoint, {})
  }

  private async rememberMint(
    withdrawLink: string,
    extra: Partial<Pick<Mint, 'payUrl' | 'fee' | 'name'>>
  ): Promise<Mint> {
    // mints are known by their host, port included: the branch is derived from it
    const domain = hostOf(withdrawLink)
    await this.commit(state => {
      const known = state.mints[domain]
      state.mints[domain] = {
        ...known,
        domain,
        withdrawLink: known?.withdrawLink ?? withdrawLink,
        payUrl: extra.payUrl ?? known?.payUrl,
        fee: extra.fee ?? known?.fee,
        name: extra.name ?? known?.name,
        addedAt: known?.addedAt ?? this.now()
      }
      state.counters[domain] ??= [0, 0, 0]
    })
    return this.state.mints[domain]
  }

  async removeMint(domain: string): Promise<void> {
    if (this.notes({mint: domain}).some(note => note.status !== 'spent'))
      throw new Error('Move or spend the notes at this mint first.')
    await this.commit(state => {
      delete state.mints[domain]
    })
  }

  /** Pins SERVICE's key on first sight; a different one later is refused. */
  private async pin(domain: string, mintPubkey?: string): Promise<void> {
    if (!mintPubkey) return
    const known = this.state.mints[domain]?.mintPubkey
    if (known && known !== mintPubkey) throw new MintKeyChangedError(domain)
    if (!known)
      await this.commit(state => {
        state.mints[domain].mintPubkey = mintPubkey
      })
  }

  /** The amount a cs1 certifies for Q under the pinned key, or null. */
  private certified(domain: string, q: Hex, c?: string): number | null {
    const key = this.state.mints[domain]?.mintPubkey
    return c && key ? verifyCertificate(c, hexToBytes(q), key) : null
  }

  // ---- keys and spends ----

  /** Takes the next index on a purpose, stored before anything is sent. */
  private async nextKey(domain: string, purpose: Purpose): Promise<KeyRef> {
    let index = 0
    await this.commit(state => {
      const counters = (state.counters[domain] ??= [0, 0, 0])
      index = counters[purpose]
      counters[purpose] = index + 1
    })
    return {purpose, index}
  }

  private async ownOutput(
    domain: string,
    purpose: Purpose,
    label: string
  ): Promise<Output> {
    const key = await this.nextKey(domain, purpose)
    return {
      q: this.keys.q(domain, key),
      spend: {kind: 'key', key},
      role: 'own',
      label
    }
  }

  private spendOf(note: Note): string {
    const spend: SpendRef = note.spend
    if (spend.kind === 'key') return this.keys.spend(note.mint, spend.key)
    if (spend.kind === 'preimage') return spend.preimage
    if (spend.kind === 'timelock')
      return this.keys.timelockSpend(note.mint, spend.key, spend.locktime)
    return spend.k1
  }

  // ---- minting ----

  /**
   * Minting: the note is a fresh key on this wallet's own branch, named in
   * the invoice's comment as cp1<Q>; SERVICE credits Q once it is paid.
   */
  async requestMint(domain: string, amountMsat: number): Promise<MintOp> {
    const mint = this.mint(domain)
    if (!mint.payUrl)
      throw new Error('Add this mint by its address to mint there.')
    const pay = await fetchPayRequest(this.net, mint.payUrl)
    if (!canMint(pay))
      throw new ServiceError('This mint no longer mints notes.')
    const output = await this.ownOutput(domain, PURPOSE.wallet, 'minted')
    const invoice = await requestInvoice(
      this.net,
      pay,
      amountMsat,
      cp1Of(output)
    )
    const op: MintOp = {
      id: id(),
      kind: 'mint',
      mint: domain,
      createdAt: this.now(),
      amountMsat,
      pr: invoice.pr,
      verify: invoice.verify,
      output
    }
    await this.commit(state => {
      state.operations[op.id] = op
      if (pay.mintFee) state.mints[domain].fee = pay.mintFee
    })
    return op
  }

  /** Looks the minted note up; true once it is credited. */
  async settleMint(op: MintOp): Promise<boolean> {
    const info = await this.lookup(op.mint, op.output.q)
    if (!info) return false
    await this.pin(op.mint, info.mintPubkey)
    await this.commit(state => {
      this.addNote(state, op.mint, op.output, info)
      delete state.operations[op.id]
      this.log(state, {
        kind: 'mint',
        mint: op.mint,
        amountMsat: info.amountMsat,
        text: 'Minted'
      })
    })
    return true
  }

  async dropMint(op: MintOp): Promise<void> {
    await this.commit(state => {
      delete state.operations[op.id]
    })
  }

  /** Informational GET by ?p=: the note's info, or null if it is unknown. */
  private async lookup(domain: string, q: Hex): Promise<NoteInfo | null> {
    try {
      return await fetchNoteInfo(this.net, this.mint(domain).withdrawLink, {
        p: encodeCp1(hexToBytes(q))
      })
    } catch (err) {
      if (err instanceof ServiceError && reason.unknown(err.reason)) return null
      throw err
    }
  }

  private addNote(
    state: WalletState,
    domain: string,
    output: Output,
    info: {amountMsat: number; c?: string}
  ): void {
    if (!output.spend) return
    const certified = this.certified(domain, output.q, info.c)
    state.notes[output.q] = {
      q: output.q,
      mint: domain,
      amountMsat: info.amountMsat,
      c: certified === info.amountMsat ? info.c : undefined,
      spend: output.spend,
      role: output.role ?? 'own',
      status: 'live',
      createdAt: this.now(),
      updatedAt: this.now()
    }
  }

  // ---- receiving ----

  /**
   * Offline circulation, then online: checks the note, keeps it as incoming,
   * and rotates it into a fresh key of this wallet's own at once.
   */
  async receive(link: NoteLink): Promise<Note> {
    const domain = hostOf(link.endpoint)
    if (!this.state.mints[domain]) throw new UnknownMintError(domain)
    const spend = decodeSpend(link.k1)
    if (!spend) throw new Error('This is not an LNURLcash note.')
    const check = checkSpend(spend, spendDomain(link.endpoint))
    if (check.status === 'invalid')
      throw new Error(`This note's spend does not open it: ${check.reason}.`)
    const q = bytesToHex(spend.q)
    if (
      this.state.notes[q]?.status === 'live' &&
      this.state.notes[q].role === 'own'
    )
      return this.state.notes[q]
    let info: NoteInfo | null = null
    try {
      info = await fetchNoteInfo(this.net, link.endpoint, {k1: link.k1})
      await this.pin(domain, info.mintPubkey)
    } catch (err) {
      if (!(err instanceof TransportError)) throw err
    }
    const amountMsat =
      info?.amountMsat ?? this.certified(domain, q, link.c) ?? link.amountMsat
    if (!amountMsat)
      throw new Error('This note carries no amount to check offline.')
    await this.commit(state => {
      state.notes[q] = {
        q,
        mint: domain,
        amountMsat,
        c: [info?.c, link.c].find(
          c => this.certified(domain, q, c) === amountMsat
        ),
        spend:
          spend.kind === 'preimage'
            ? {kind: 'preimage', preimage: bytesToHex(spend.preimage)}
            : {kind: 'k1', k1: link.k1},
        role: 'incoming',
        status: 'live',
        createdAt: this.now(),
        updatedAt: this.now()
      }
      this.log(state, {
        kind: 'receive',
        mint: domain,
        amountMsat,
        text: 'Received'
      })
    })
    if (info) await this.claim(q)
    return this.state.notes[q]
  }

  /** Rotates an incoming note into this wallet's own key. */
  async claim(q: Hex): Promise<void> {
    const note = this.state.notes[q]
    if (!note || note.role !== 'incoming' || note.status !== 'live') return
    const p1 = await this.ownOutput(note.mint, PURPOSE.wallet, 'claimed')
    await this.runBurn({purpose: 'claim', mint: note.mint, inputs: [note], p1})
  }

  // ---- sending ----

  /**
   * A bearer note worth `amountMsat` to hand out as a link: its hex
   * preimage is the whole secret, so any LUD-03 wallet can redeem it.
   */
  async send(domain: string, amountMsat: number, memo?: string): Promise<Note> {
    const preimage = newPreimage()
    const p1: Output = {
      q: bytesToHex(bearerNote(sha256(preimage)).q),
      spend: {kind: 'preimage', preimage: bytesToHex(preimage)},
      role: 'outgoing',
      label: 'sent'
    }
    await this.spendInto(domain, amountMsat, p1, 'send')
    const note = this.state.notes[p1.q]
    await this.commit(state => {
      if (memo) note.memo = memo
      this.log(state, {
        kind: 'send',
        mint: domain,
        amountMsat,
        text: 'Made a note to hand out'
      })
    })
    return note
  }

  /**
   * Timelocks: moves `amountMsat` into a note only this wallet can spend,
   * and only from `locktime` (Unix seconds) on. SERVICE enforces it by its
   * own clock: a custodial policy, not a trustless lock. The locktime is
   * not in the seed, so this note is found again only with the wallet's
   * records, not by a scan from the words alone.
   */
  async lock(
    domain: string,
    amountMsat: number,
    locktime: number
  ): Promise<Note> {
    if (locktime <= Math.floor(this.now() / 1000))
      throw new Error('Pick a time in the future.')
    const key = await this.nextKey(domain, PURPOSE.wallet)
    const p1: Output = {
      q: this.keys.timelockQ(domain, key, locktime),
      spend: {kind: 'timelock', key, locktime},
      role: 'locked',
      label: 'locked'
    }
    await this.spendInto(domain, amountMsat, p1, 'rotate')
    await this.commit(state =>
      this.log(state, {
        kind: 'lock',
        mint: domain,
        amountMsat,
        text: `Locked until ${new Date(locktime * 1000).toISOString().slice(0, 16)}Z`
      })
    )
    return this.state.notes[p1.q]
  }

  /** Moves a locked note whose time has come back into the balance. */
  async unlock(q: Hex): Promise<void> {
    const note = this.state.notes[q]
    if (!note || note.role !== 'locked' || note.status !== 'live') return
    if (
      note.spend.kind === 'timelock' &&
      note.spend.locktime > Math.floor(this.now() / 1000)
    )
      throw new Error('This note is still locked.')
    const p1 = await this.ownOutput(note.mint, PURPOSE.wallet, 'unlocked')
    await this.runBurn({purpose: 'rotate', mint: note.mint, inputs: [note], p1})
  }

  /** Takes back a sent note nobody has rotated yet. */
  async reclaim(q: Hex): Promise<void> {
    const note = this.state.notes[q]
    if (!note || note.role !== 'outgoing' || note.status !== 'live') return
    const p1 = await this.ownOutput(note.mint, PURPOSE.wallet, 'reclaimed')
    await this.runBurn({purpose: 'rotate', mint: note.mint, inputs: [note], p1})
    await this.commit(state =>
      this.log(state, {
        kind: 'reclaim',
        mint: note.mint,
        amountMsat: note.amountMsat,
        text: 'Reclaimed'
      })
    )
  }

  /** Sends `amountMsat` straight to a note key someone gave as a cp1. */
  async sendToKey(
    domain: string,
    amountMsat: number,
    cp1Q: Uint8Array
  ): Promise<void> {
    const p1: Output = {q: bytesToHex(cp1Q), label: 'sent to key'}
    await this.spendInto(domain, amountMsat, p1, 'transfer')
    await this.commit(state =>
      this.log(state, {
        kind: 'transfer',
        mint: domain,
        amountMsat,
        text: 'Sent to a note key'
      })
    )
  }

  /**
   * Internal transfer: pays a Lightning Address at the same mint by minting
   * straight onto the payee's purpose-2 key, retrying at the next index
   * whenever SERVICE says the hinted one is already in use.
   */
  async transfer(pay: PayRequest, amountMsat: number): Promise<void> {
    if (!pay.cpub || !pay.withdrawLink)
      throw new Error('This address takes no internal transfers.')
    const domain = hostOf(pay.withdrawLink)
    for (let attempt = 0; attempt < MAX_INDEX_RETRIES; attempt++) {
      const q = notePubkey(
        pay.cpub.branch,
        PURPOSE.lightningAddress,
        pay.cpub.index + attempt
      )
      try {
        await this.spendInto(
          domain,
          amountMsat,
          {q: bytesToHex(q), label: 'transfer'},
          'transfer'
        )
        await this.commit(state =>
          this.log(state, {
            kind: 'transfer',
            mint: domain,
            amountMsat,
            text: `Sent to ${pay.identifier ?? 'an address'}`
          })
        )
        return
      } catch (err) {
        if (!(err instanceof ServiceError && reason.alreadyInUse(err.reason)))
          throw err
      }
    }
    throw new Error(
      'The payee has no free note key right now. Try again later.'
    )
  }

  /**
   * Burns notes at `domain` so that `p1` ends up worth exactly
   * `amountMsat`: a rotate when one note already is, else a split whose
   * change comes back on purpose 1.
   */
  private async spendInto(
    domain: string,
    amountMsat: number,
    p1: Output,
    purpose: Burn['purpose']
  ): Promise<void> {
    const fee = this.state.mints[domain]?.fee?.baseMsat ?? 0
    const selection = selectNotes(
      this.notes({mint: domain, role: 'own', status: 'live'}),
      amountMsat,
      fee
    )
    if (!selection)
      throw new Error('Not enough funds at this mint for that amount.')
    if (selection.mode === 'exact') {
      await this.runBurn({purpose, mint: domain, inputs: selection.inputs, p1})
      return
    }
    const p2 = await this.ownOutput(domain, PURPOSE.change, 'change')
    await this.runBurn({
      purpose,
      mint: domain,
      inputs: selection.inputs,
      p1,
      split: {amountMsat, p2}
    })
  }

  // ---- paying ----

  /**
   * Pays a BOLT-11 invoice from notes at `domain`: a note worth exactly
   * the invoice is split off first when needed, then melted (LUD-03).
   */
  async pay(domain: string, invoice: string): Promise<Melt> {
    const amountMsat = invoiceAmountMsat(invoice)
    if (!amountMsat)
      throw new Error('Only invoices with an amount can be paid.')
    let note = this.notes({mint: domain, role: 'own', status: 'live'}).find(
      candidate => candidate.amountMsat === amountMsat
    )
    if (!note) {
      const p1 = await this.ownOutput(domain, PURPOSE.wallet, 'payment')
      await this.spendInto(domain, amountMsat, p1, 'pay')
      note = this.state.notes[p1.q]
    }
    const info = await this.lookup(domain, note.q)
    if (!info) throw new Error('The mint does not know the note to pay with.')
    const op: Melt = {
      id: id(),
      kind: 'melt',
      mint: domain,
      createdAt: this.now(),
      callback: info.callback,
      input: note.q,
      k1: this.spendOf(note),
      pr: invoice,
      amountMsat,
      state: 'prepared'
    }
    await this.commit(state => {
      state.operations[op.id] = op
      state.notes[note!.q].status = 'pending'
    })
    try {
      const result = await melt(this.net, op.callback, op.k1, op.pr)
      await this.commit(state => {
        const stored = state.operations[op.id] as Melt
        stored.state = 'in-flight'
        stored.verify = result.verify
      })
    } catch (err) {
      if (err instanceof ServiceError) {
        await this.commit(state => {
          delete state.operations[op.id]
          state.notes[note!.q].status = 'live'
        })
      } else {
        await this.commit(state => {
          ;(state.operations[op.id] as Melt).state = 'unknown'
        })
      }
      throw err
    }
    return this.state.operations[op.id] as Melt
  }

  /**
   * A melt is not replayed: its note says how it went. Pending: still in
   * flight. Spent: paid. Outstanding again: the payment failed.
   */
  async settleMelt(op: Melt): Promise<'paid' | 'in-flight' | 'failed'> {
    let outcome: 'paid' | 'in-flight' | 'failed'
    try {
      // outstanding again: the payment failed, or the melt never arrived
      if (!(await this.lookup(op.mint, op.input)))
        throw new Error('The mint no longer knows the note this payment used.')
      outcome = 'failed'
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err
      if (reason.pending(err.reason)) return 'in-flight'
      if (!reason.spent(err.reason)) throw err
      outcome = 'paid'
    }
    await this.commit(state => {
      delete state.operations[op.id]
      const note = state.notes[op.input]
      if (note) {
        note.status = outcome === 'paid' ? 'spent' : 'live'
        note.updatedAt = this.now()
      }
      if (outcome === 'paid')
        this.log(state, {
          kind: 'pay',
          mint: op.mint,
          amountMsat: op.amountMsat,
          text: 'Paid an invoice'
        })
    })
    return outcome
  }

  // ---- the burn journal ----

  private async runBurn(plan: {
    purpose: Burn['purpose']
    mint: string
    inputs: Note[]
    p1: Output
    split?: {amountMsat: number; p2: Output}
  }): Promise<void> {
    const info = await this.lookupCallback(plan.mint, plan.inputs[0])
    const op: Burn = {
      id: id(),
      kind: 'burn',
      mint: plan.mint,
      createdAt: this.now(),
      callback: info,
      inputs: plan.inputs.map(note => note.q),
      k1s: plan.inputs.map(note => this.spendOf(note)),
      p1: plan.p1,
      split: plan.split,
      purpose: plan.purpose,
      state: 'prepared'
    }
    await this.commit(state => {
      state.operations[op.id] = op
      for (const q of op.inputs) state.notes[q].status = 'pending'
    })
    await this.sendBurn(op)
  }

  /** The callback comes from the informational GET; any live input will do. */
  private async lookupCallback(domain: string, note: Note): Promise<string> {
    const info = await this.lookup(domain, note.q)
    if (!info) throw new Error('The mint does not know this note.')
    return info.callback
  }

  private async sendBurn(op: Burn): Promise<void> {
    let certificates: Certificates
    try {
      certificates = await burn(
        this.net,
        op.callback,
        op.k1s,
        cp1Of(op.p1),
        op.split && {amountMsat: op.split.amountMsat, p2: cp1Of(op.split.p2)}
      )
    } catch (err) {
      if (err instanceof ServiceError) {
        await this.commit(state => {
          delete state.operations[op.id]
          for (const q of op.inputs) state.notes[q].status = 'live'
        })
        if (reason.spent(err.reason) || reason.unknown(err.reason))
          for (const q of op.inputs) await this.refreshNote(q)
      } else {
        await this.commit(state => {
          ;(state.operations[op.id] as Burn).state = 'unknown'
        })
      }
      throw err
    }
    await this.applyBurn(op, certificates)
  }

  /** What SERVICE should credit: the split amount and the rest less the base fee, or a merge's sum plus its refund. */
  private expectedAmounts(op: Burn): number[] {
    const total = op.inputs.reduce(
      (sum, q) => sum + this.state.notes[q].amountMsat,
      0
    )
    const fee = this.state.mints[op.mint]?.fee?.baseMsat ?? 0
    if (op.split)
      return [op.split.amountMsat, total - op.split.amountMsat - fee]
    return [total + (op.inputs.length - 1) * fee]
  }

  private async applyBurn(op: Burn, certificates: Certificates): Promise<void> {
    const outputs: [Output, string | undefined][] = [[op.p1, certificates.c]]
    if (op.split) outputs.push([op.split.p2, certificates.c2])
    // amounts come from SERVICE's certificates, else a lookup, else the fee rules
    const expected = this.expectedAmounts(op)
    const amounts: number[] = []
    for (const [i, [output, c]] of outputs.entries()) {
      let amount = this.certified(op.mint, output.q, c)
      if (amount === null && output.spend)
        amount =
          (await this.lookup(op.mint, output.q).catch(() => null))
            ?.amountMsat ?? null
      amounts.push(amount ?? expected[i])
    }
    await this.commit(state => {
      for (const q of op.inputs) {
        state.notes[q].status = 'spent'
        state.notes[q].updatedAt = this.now()
      }
      outputs.forEach(([output, c], i) =>
        this.addNote(state, op.mint, output, {amountMsat: amounts[i], c})
      )
      delete state.operations[op.id]
    })
  }

  /** Settles every journal entry that is still open. */
  async settle(): Promise<void> {
    const tasks: (() => Promise<unknown>)[] = [
      ...Object.values(this.state.operations).map(op => () => {
        if (op.kind === 'mint') return this.settleMint(op)
        if (op.kind === 'melt') return this.settleMelt(op)
        return this.resolveBurn(op)
      }),
      // notes received offline are rotated as soon as the mint answers
      ...this.notes({role: 'incoming', status: 'live'}).map(
        note => () => this.claim(note.q)
      ),
      () => this.checkOutgoing()
    ]
    for (const task of tasks) {
      try {
        await task()
      } catch (err) {
        if (!(err instanceof TransportError)) throw err
      }
    }
  }

  /** Re-reads one note's status from its mint. */
  private async refreshNote(q: Hex): Promise<void> {
    const note = this.state.notes[q]
    if (!note) return
    let status: Note['status'] = 'live'
    let amountMsat = note.amountMsat
    try {
      const info = await this.lookup(note.mint, q)
      if (!info) status = 'spent'
      else amountMsat = info.amountMsat
    } catch (err) {
      if (err instanceof ServiceError && reason.spent(err.reason))
        status = 'spent'
      else if (err instanceof ServiceError && reason.pending(err.reason))
        status = 'pending'
      else return
    }
    await this.commit(state => {
      Object.assign(state.notes[q], {status, amountMsat, updatedAt: this.now()})
    })
  }

  /**
   * A burn whose answer was lost: asking again is a replay (Retrying a
   * mutation). If SERVICE refuses the replay, p1 tells whether it landed.
   */
  private async resolveBurn(op: Burn): Promise<void> {
    if (op.state !== 'unknown') {
      // prepared but never sent: nothing happened yet
      await this.commit(state => {
        delete state.operations[op.id]
        for (const q of op.inputs) state.notes[q].status = 'live'
      })
      return
    }
    try {
      await this.sendBurn(op)
    } catch (err) {
      if (!(err instanceof ServiceError)) return
      const landed = await this.lookup(op.mint, op.p1.q).catch(() => null)
      if (landed) await this.applyBurn(op, {c: landed.c})
    }
  }

  // ---- recovery and Lightning Address ----

  /**
   * Seed & derivation: re-derives each purpose's keys at a mint and looks
   * them up with ?p=, until `gapLimit` in a row are unknown. Spent keys
   * count as used; a rate limit is waited out, never counted.
   */
  async recover(
    domain: string,
    onProgress?: (purpose: Purpose, index: number) => void
  ): Promise<number> {
    let found = 0
    for (const purpose of [
      PURPOSE.wallet,
      PURPOSE.change,
      PURPOSE.lightningAddress
    ]) {
      found += await this.scan(domain, purpose, 0, onProgress)
    }
    if (found)
      await this.commit(state =>
        this.log(state, {
          kind: 'recover',
          mint: domain,
          text: `Recovered ${found} notes`
        })
      )
    return found
  }

  /** Walks one purpose from `start`; returns the notes it added. */
  private async scan(
    domain: string,
    purpose: Purpose,
    start: number,
    onProgress?: (purpose: Purpose, index: number) => void,
    until = 0
  ): Promise<number> {
    const gapLimit = this.state.settings.gapLimit
    let gap = 0
    let found = 0
    let highest = -1
    for (let index = start; gap < gapLimit || index <= until; index++) {
      onProgress?.(purpose, index)
      const key: KeyRef = {purpose, index}
      const q = this.keys.q(domain, key)
      let info: NoteInfo | null
      try {
        info = await this.lookup(domain, q)
      } catch (err) {
        if (err instanceof ServiceError && reason.rateLimited(err.reason)) {
          await new Promise(resolve => setTimeout(resolve, 2000))
          index--
          continue
        }
        if (err instanceof ServiceError && reason.spent(err.reason)) {
          highest = index
          gap = 0
          continue
        }
        throw err
      }
      if (!info) {
        gap++
        continue
      }
      highest = index
      gap = 0
      await this.pin(domain, info.mintPubkey)
      if (!this.state.notes[q]) {
        found++
        await this.commit(state =>
          this.addNote(
            state,
            domain,
            {q, spend: {kind: 'key', key}, role: 'own', label: 'recovered'},
            info!
          )
        )
      }
    }
    await this.commit(state => {
      const counters = (state.counters[domain] ??= [0, 0, 0])
      counters[purpose] = Math.max(counters[purpose], highest + 1)
    })
    return found
  }

  /**
   * Lightning Address auto-mint: whatever arrived on purpose 2 since the
   * last look, re-checking a gap-limit window behind it too.
   */
  async checkAddress(domain: string): Promise<number> {
    const gapLimit = this.state.settings.gapLimit
    const next = this.state.counters[domain]?.[PURPOSE.lightningAddress] ?? 0
    // SERVICE's text/cpub hint: the next index it will hand out. Never
    // trusted as a floor, only walked up to (plus a gap-limit margin).
    let hint = 0
    const address = this.state.addresses[domain]
    if (address) {
      const origin = new URL(this.mint(domain).withdrawLink).origin
      const pay = await fetchPayRequest(
        this.net,
        `${origin}/.well-known/lnurlp/${address.username}`
      )
      hint = pay.cpub?.index ?? 0
    }
    const start = Math.max(0, next - gapLimit)
    const found = await this.scan(
      domain,
      PURPOSE.lightningAddress,
      start,
      undefined,
      hint + gapLimit
    )
    if (found)
      await this.commit(state =>
        this.log(state, {
          kind: 'receive',
          mint: domain,
          text: `Received ${found} payments to your address`
        })
      )
    return found
  }

  async registerAddress(domain: string, username: string): Promise<void> {
    const name = username.trim().toLowerCase()
    const mint = this.mint(domain)
    await registerUsername(
      this.net,
      mint.withdrawLink,
      name,
      this.keys.cx1(domain),
      this.keys.addressProof(domain, 'register', name)
    )
    await this.commit(state => {
      state.addresses[domain] = {
        username: name,
        mint: domain,
        since: this.now()
      }
      this.log(state, {
        kind: 'address',
        mint: domain,
        text: `Registered ${name}@${domain}`
      })
    })
  }

  async unregisterAddress(domain: string): Promise<void> {
    const address = this.state.addresses[domain]
    if (!address) return
    await unregisterUsername(
      this.net,
      this.mint(domain).withdrawLink,
      address.username,
      this.keys.addressProof(domain, 'unregister', address.username)
    )
    await this.commit(state => {
      delete state.addresses[domain]
    })
  }

  /**
   * The one-time import (legacy.ts): walks the old Bearlett's two ladders at
   * a mint and rotates whatever is still outstanding into today's keys. The
   * old wallet derived with the host as the URL gave it, port included, so
   * both spellings are walked when they differ.
   */
  async importLegacy(domain: string): Promise<number> {
    const url = new URL(this.mint(domain).withdrawLink)
    const spellings = [
      ...new Set([url.hostname.toLowerCase(), url.host.toLowerCase()])
    ]
    const gapLimit = this.state.settings.gapLimit
    let found = 0
    for (const spelling of spellings) {
      const branch = this.keys.legacyBranch(spelling)
      let gap = 0
      for (let index = 0; gap < gapLimit; index++) {
        let used = false
        for (const candidate of legacyCandidates(
          branch,
          spendDomainOfHost(domain),
          index
        )) {
          let info: NoteInfo | null
          try {
            info = await this.lookup(domain, candidate.q)
          } catch (err) {
            if (err instanceof ServiceError && reason.spent(err.reason)) {
              used = true
              continue
            }
            throw err
          }
          if (!info) continue
          used = true
          if (this.state.notes[candidate.q]) continue
          found++
          await this.commit(state => {
            state.notes[candidate.q] = {
              q: candidate.q,
              mint: domain,
              amountMsat: info!.amountMsat,
              spend:
                candidate.spend === 'preimage'
                  ? {kind: 'preimage', preimage: candidate.k1}
                  : {kind: 'k1', k1: candidate.k1},
              role: 'incoming',
              status: 'live',
              createdAt: this.now(),
              updatedAt: this.now()
            }
          })
        }
        gap = used ? 0 : gap + 1
      }
    }
    for (const note of this.notes({
      mint: domain,
      role: 'incoming',
      status: 'live'
    }))
      await this.claim(note.q)
    if (found)
      await this.commit(state =>
        this.log(state, {
          kind: 'recover',
          mint: domain,
          text: `Imported ${found} notes from the old Bearlett`
        })
      )
    return found
  }

  /** Whether sent notes were rotated by their recipients yet. */
  async checkOutgoing(): Promise<void> {
    for (const note of this.notes({role: 'outgoing', status: 'live'})) {
      try {
        await this.lookup(note.mint, note.q)
      } catch (err) {
        if (err instanceof ServiceError && reason.spent(err.reason))
          await this.commit(state => {
            state.notes[note.q].status = 'spent'
            state.notes[note.q].updatedAt = this.now()
          })
      }
    }
  }
}

import {
  Wallet as CashuWallet,
  Mint,
  OutputData,
  Amount,
  deserializeProofs,
  serializeProofs,
  serializeSwapPreview,
  deserializeSwapPreview,
  getDecodedToken,
  getDecodedTokenBinary,
  getEncodedToken,
  sumProofs
} from '@cashu/cashu-ts'
import type {
  Proof,
  MintQuoteBolt11Response,
  MeltQuoteBolt11Response,
  CounterSource
} from '@cashu/cashu-ts'
import {mnemonicToSeedSync} from '@scure/bip39'
import {HDKey} from '@scure/bip32'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {
  decodeBolt11AmountMsat,
  verifyMeltPreimage,
  sameInvoice
} from '../../lnurlcash'
import {
  isValidSeedPhrase,
  cashRootToHex,
  deriveLud25CashRootNode
} from '../../keys'
import type {Vault, Note, CashState} from '../vault'
import {asset, validateCashuState} from './state'
import type {CashuState, CashuJournal, CashuAsset} from './state'
import {cashuRequest, mintUrl} from './transport'
import type {CashuHost} from './transport'
import {invoiceAmount} from './invoice'

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const STATE = 'cashu-v1'

/** Split legacy multi-mint envelopes before any mint is contacted. */
export function decodeCashu(
  input: string
): (ReturnType<typeof getDecodedToken> & {encoded: string})[] {
  const token = input.trim().replace(/^cashu:/i, '')
  if (token.length > 256000) throw new Error('Cashu token is too large.')
  let tokens = [token]
  if (token.startsWith('cashuA')) {
    const raw = token.slice(6).replace(/-/g, '+').replace(/_/g, '/')
    const old = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0)))
    )
    if (!Array.isArray(old.token) || !old.token.length || old.token.length > 20)
      throw new Error('Invalid Cashu token.')
    tokens = old.token.map(
      (entry: unknown) =>
        'cashuA' +
        btoa(
          Array.from(
            new TextEncoder().encode(JSON.stringify({...old, token: [entry]})),
            b => String.fromCharCode(b)
          ).join('')
        )
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
    )
  }
  return tokens.map(t => {
    const decoded = t.startsWith('cashuB')
      ? getDecodedTokenBinary(
          new Uint8Array([
            ...new TextEncoder().encode('crawB'),
            ...Uint8Array.from(
              atob(t.slice(6).replace(/-/g, '+').replace(/_/g, '/')),
              c => c.charCodeAt(0)
            )
          ])
        )
      : getDecodedToken(t, [])
    if (
      decoded.unit !== 'sat' ||
      !decoded.proofs.length ||
      decoded.proofs.length > 2048
    )
      throw new Error(
        'Only Cashu sat tokens with up to 2048 proofs are supported.'
      )
    mintUrl(decoded.mint)
    if (decoded.proofs.some(p => p.secret.trimStart().startsWith('[')))
      throw new Error('Locked Cashu tokens are not supported.')
    return {...decoded, encoded: t}
  })
}

/** All proof ownership and its journal are committed in one encrypted storage item. */
export class CashuEngine {
  private running = false
  constructor(
    readonly vault: Vault,
    readonly host?: CashuHost,
    private offline: () => boolean = () => false
  ) {}

  /** Serialize mutations on this engine; Vault.exclusive is the local writer lock. */
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('Another Cashu operation is running.')
    this.running = true
    try {
      return await this.vault.exclusive(action)
    } finally {
      this.running = false
    }
  }
  /** Read and validate the durable encrypted snapshot. */
  async state(): Promise<CashuState> {
    const state = await this.vault.meta<CashuState>(STATE)
    if (!state) throw new Error('Enable Cashu with your recovery phrase first.')
    validateCashuState(state)
    return state
  }
  /** Keep an acknowledged snapshot before contacting the mint. */
  async save(state: CashuState): Promise<void> {
    validateCashuState(state)
    await this.vault.setMeta(STATE, state)
  }
  /** Initialize Cashu from the same seed, proving it belongs to the LNURLcash wallet. */
  async enable(phrase: string, restored = true): Promise<void> {
    if (!isValidSeedPhrase(phrase)) throw new Error('Invalid recovery phrase.')
    const cash = await this.vault.meta<CashState>('cash')
    if (!cash || cash.root !== cashRootToHex(deriveLud25CashRootNode(phrase)))
      throw new Error('Recovery phrase does not match this wallet.')
    if (await this.vault.meta(STATE))
      throw new Error('Cashu is already enabled.')
    const seed = mnemonicToSeedSync(phrase.trim().toLowerCase())
    try {
      await this.save({
        version: 1,
        seed: bytesToHex(seed),
        counters: {},
        quoteCounter: 0,
        assets: [],
        operations: [],
        restored,
        scanned: []
      })
    } finally {
      seed.fill(0)
    }
  }
  /** Return public collection fields only. */
  async notes(): Promise<Note[]> {
    return (
      (await this.vault.meta<CashuState>(STATE))?.assets.map(a => a.note) ?? []
    )
  }
  /** Obtain a protocol wallet with durable, monotonic counters and a mediated transport. */
  private async client(mint: string, payment = false): Promise<CashuWallet> {
    const check = this.vault.sessionGuard()
    await this.vault.assertReady()
    if (!this.host)
      throw new Error('This shell does not provide the Cashu capability.')
    const state = await this.state(),
      base = mintUrl(mint)
    const source: CounterSource = {
      reserve: async (id, n) => {
        const s = await this.state(),
          start = s.counters[id] ?? 0
        if (n && s.restored)
          throw new Error(
            'Migrate recovered proofs into a fresh wallet. A seed scan cannot prove exclusive ownership.'
          )
        if (
          !Number.isSafeInteger(n) ||
          n < 0 ||
          !Number.isSafeInteger(start + n)
        )
          throw new Error('Invalid counter reservation.')
        if (n) {
          s.counters[id] = start + n
          await this.save(s)
        }
        return {start, count: n}
      },
      advanceToAtLeast: async (id, next) => {
        const s = await this.state()
        s.counters[id] = Math.max(s.counters[id] ?? 0, next)
        await this.save(s)
      }
    }
    const quotes = Object.fromEntries(
      state.operations
        .filter(o => o.mint === base && o.quote)
        .map(o => [String(o.quote!.quote), o])
    )
    const wallet = new CashuWallet(
      new Mint(base, {
        customRequest: cashuRequest(
          {
            request: async request => {
              check()
              const response = await this.host!.request(request)
              check()
              return response
            }
          },
          base,
          this.offline,
          quotes
        )
      }),
      {
        unit: 'sat',
        bip39seed: hexToBytes(state.seed),
        counterSource: source,
        secretsPolicy: 'deterministic'
      }
    )
    await wallet.loadMint()
    for (const nut of payment ? ([7, 8, 9] as const) : ([7, 9] as const))
      if (!wallet.getMintInfo().isSupported(nut).supported)
        throw new Error(
          `This mint needs NUT-${nut} for recoverable operations.`
        )
    return wallet
  }
  /** Store an incoming token before rotating it; previous copies never enter the available balance. */
  async receive(input: string): Promise<void> {
    await this.exclusive(async () => {
      for (const token of decodeCashu(input)) {
        const s = await this.state(),
          base = mintUrl(token.mint)
        const client = await this.client(base)
        token.proofs = getDecodedToken(
          token.encoded,
          client.keyChain.getAllKeysetIds()
        ).proofs
        const known = new Set(
          s.assets
            .filter(a => a.note.url === base)
            .flatMap(a => deserializeProofs(a.proofs).map(p => p.secret))
        )
        if (token.proofs.some(p => known.has(p.secret)))
          throw new Error(
            'This Cashu token is already recorded. Check its stored note instead.'
          )
        const incoming = asset(base, token.proofs, 'unverified')
        s.assets.push(incoming)
        await this.save(s)
        await this.swap([incoming.note.id])
      }
    })
  }
  private select(
    s: CashuState,
    ids: string[],
    allowIncoming = false
  ): CashuAsset[] {
    if (!ids.length || new Set(ids).size !== ids.length)
      throw new Error('Select Cashu notes.')
    const selected = ids.map(id => {
      const a = s.assets.find(a => a.note.id === id)
      if (
        !a ||
        !['ready', ...(allowIncoming ? ['unverified'] : [])].includes(
          a.note.status
        )
      )
        throw new Error('Select available Cashu notes.')
      return a
    })
    if (new Set(selected.map(a => a.note.url)).size !== 1)
      throw new Error('Select notes from one mint.')
    return selected
  }
  private async record(op: CashuJournal, reserve = true): Promise<void> {
    const s = await this.state()
    if (reserve)
      for (const id of op.inputs)
        s.assets.find(a => a.note.id === id)!.note.status = 'pending'
    const index = s.operations.findIndex(o => o.id === op.id)
    if (index < 0) s.operations.push(op)
    else s.operations[index] = op
    await this.save(s)
  }
  private async finish(op: CashuJournal, groups: Proof[][]): Promise<void> {
    const s = await this.state(),
      stored = s.operations.find(o => o.id === op.id)!
    if (stored.phase === 'complete') return
    for (const id of op.inputs)
      s.assets.find(a => a.note.id === id)!.note.status = 'spent'
    const received = groups.filter(g => g.length).map(g => asset(op.mint, g))
    if (s.restored)
      for (const a of received) {
        a.note.status = 'unverified'
        a.note.reason =
          'Recovered output: migrate to a fresh wallet before spending.'
      }
    const appearance = s.assets.find(a => a.note.id === op.inputs[0])?.note
    if (appearance)
      for (const a of received) {
        a.note.designId = appearance.designId
        a.note.label = appearance.label
      }
    s.assets.push(...received)
    stored.phase = 'complete'
    stored.receivedIds = received.map(a => a.note.id)
    delete stored.error
    await this.save(s)
  }
  private async swap(ids: string[], amount?: number): Promise<void> {
    const selected = this.select(await this.state(), ids, true),
      mint = selected[0].note.url
    const wallet = await this.client(mint),
      proofs = selected.flatMap(a => deserializeProofs(a.proofs))
    const preview =
      amount === undefined
        ? await wallet.prepareSwapToReceive(proofs)
        : await wallet.prepareSwapToSend(amount, proofs, {includeFees: false})
    const op: CashuJournal = {
      id: crypto.randomUUID(),
      mint,
      kind: 'swap',
      phase: 'prepared',
      inputs: ids,
      createdAt: Date.now(),
      receivedIds: [],
      swap: serializeSwapPreview(preview)
    }
    await this.record(op)
    op.phase = 'submitted'
    await this.record(op)
    const result = await wallet.completeSwap(preview)
    await this.finish(op, [result.send, result.keep])
  }
  /** Rotate, combine or split using a persisted, replay-safe swap preview. */
  async transform(ids: string[], amount?: number): Promise<void> {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0))
      throw new Error('Cashu amounts must be whole sats.')
    await this.exclusive(() => this.swap(ids, amount))
  }
  /** Reserve proofs before revealing a standard Cashu bearer token. */
  async share(id: string): Promise<string> {
    return this.exclusive(async () => {
      const s = await this.state(),
        a = s.assets.find(a => a.note.id === id)
      if (!a || !['ready', 'shared'].includes(a.note.status))
        throw new Error('Select an available or previously shared note.')
      const token = getEncodedToken({
        mint: a.note.url,
        unit: 'sat',
        proofs: deserializeProofs(a.proofs)
      })
      a.note.status = 'shared'
      a.note.reason = 'Handed over; excluded from available balance.'
      await this.save(s)
      return token
    })
  }
  /** Reserve recovered bearer proofs for explicit migration into a fresh wallet. */
  async exportRecovery(id: string): Promise<string> {
    return this.exclusive(async () => {
      const state = await this.state()
      const note = state.assets.find(a => a.note.id === id)
      if (
        !state.restored ||
        !note ||
        !['unverified', 'shared'].includes(note.note.status) ||
        state.operations.some(
          op =>
            op.phase !== 'complete' &&
            (op.inputs.includes(id) || op.receivedIds.includes(id))
        )
      )
        throw new Error(
          'Reconcile pending operations before moving recovered proofs.'
        )
      const wallet = await this.client(note.note.url)
      const proofs = deserializeProofs(note.proofs)
      const states = await wallet.checkProofsStates(proofs)
      if (
        states.length !== proofs.length ||
        states.some(p => p.state !== 'UNSPENT')
      )
        throw new Error(
          'Recovered proofs are spent or pending; keep their recovery record.'
        )
      note.note.status = 'shared'
      note.note.reason =
        'Recovery handover: import and rotate in a fresh wallet. Old copies remain valid until claimed.'
      await this.save(state)
      return getEncodedToken({mint: note.note.url, unit: 'sat', proofs})
    })
  }
  /** Prepare a funding quote while retaining its private redemption key. */
  async mint(mint: string, amount: number): Promise<CashuJournal> {
    return this.exclusive(async () => {
      if (!Number.isSafeInteger(amount) || amount <= 0)
        throw new Error('Enter a whole sat amount.')
      const wallet = await this.client(mint),
        s = await this.state()
      const key = HDKey.fromMasterSeed(hexToBytes(s.seed)).derive(
        `m/129373'/20'/0'/0'/${s.quoteCounter}`
      ).privateKey!
      s.quoteCounter++
      await this.save(s)
      const locked = wallet.getMintInfo().isSupported(20).supported
      const quote = await wallet.createMintQuote<MintQuoteBolt11Response>(
        'bolt11',
        {
          amount,
          ...(locked ? {pubkey: bytesToHex(secp256k1.getPublicKey(key))} : {})
        }
      )
      if (
        invoiceAmount(quote.request) !== amount * 1000 ||
        (locked && quote.pubkey !== bytesToHex(secp256k1.getPublicKey(key)))
      )
        throw new Error(
          'Mint quote does not match the requested amount or key.'
        )
      const op: CashuJournal = {
        id: crypto.randomUUID(),
        kind: 'mint',
        mint: mintUrl(mint),
        phase: 'prepared',
        inputs: [],
        receivedIds: [],
        createdAt: Date.now(),
        invoice: quote.request,
        quote: json(quote) as unknown as Record<string, unknown>,
        quoteKey: locked ? bytesToHex(key) : undefined
      }
      await this.record(op)
      key.fill(0)
      return op
    })
  }
  /** Prepare the exact quote and blank change outputs before requesting payment. */
  async preparePayment(ids: string[], invoice: string): Promise<CashuJournal> {
    return this.exclusive(async () => {
      const msat = invoiceAmount(invoice)
      if (!msat || !Number.isSafeInteger(msat))
        throw new Error('Use a fixed-amount BOLT11 invoice.')
      const selected = this.select(await this.state(), ids),
        mint = selected[0].note.url
      const wallet = await this.client(mint, true),
        proofs = selected.flatMap(a => deserializeProofs(a.proofs))
      const quote = await wallet.createMeltQuoteBolt11(invoice)
      if (
        (quote.request && !sameInvoice(quote.request, invoice)) ||
        Amount.from(quote.amount).toNumber() !== Math.ceil(msat / 1000)
      )
        throw new Error('Melt quote changed the requested payment.')
      const inputFee = wallet.getFeesForProofs(proofs).toNumber()
      const maximumDebit = Amount.from(quote.amount)
        .add(quote.fee_reserve)
        .add(inputFee)
        .toNumber()
      const reservedAmount = sumProofs(proofs).toNumber()
      if (reservedAmount < maximumDebit)
        throw new Error(
          'Selected notes do not cover the invoice, routing reserve and mint input fee.'
        )
      const preview = await wallet.prepareMelt('bolt11', quote, proofs)
      const op: CashuJournal = {
        id: crypto.randomUUID(),
        mint,
        kind: 'melt',
        phase: 'prepared',
        inputs: ids,
        receivedIds: [],
        createdAt: Date.now(),
        invoice,
        inputFee,
        maximumDebit,
        reservedAmount,
        quote: json(quote) as unknown as Record<string, unknown>,
        keysetId: preview.keysetId,
        outputs: preview.outputData.map(OutputData.serialize)
      }
      await this.record(op)
      return op
    })
  }
  /** Dispatch a prepared payment exactly once. After ambiguity use status/restore, never another melt. */
  async pay(operationId: string): Promise<void> {
    await this.exclusive(async () => {
      const s = await this.state(),
        op = s.operations.find(o => o.id === operationId)
      if (!op || op.kind !== 'melt' || op.phase !== 'prepared')
        throw new Error('Payment is not awaiting confirmation.')
      invoiceAmount(op.invoice!)
      if (Number(op.quote!.expiry) * 1000 <= Date.now())
        throw new Error(
          'Payment quote expired. Cancel the unsubmitted payment and prepare again.'
        )
      const wallet = await this.client(op.mint, true)
      op.phase = 'submitted'
      await this.record(op)
      const result = await wallet.completeMelt(
        {
          method: 'bolt11',
          inputs: op.inputs.flatMap(id =>
            deserializeProofs(s.assets.find(a => a.note.id === id)!.proofs)
          ),
          outputData: op.outputs!.map(OutputData.deserialize),
          keysetId: op.keysetId!,
          quote: op.quote as unknown as MeltQuoteBolt11Response
        },
        undefined,
        {preferAsync: true}
      )
      if (result.quote.state === 'PAID') {
        if (
          !verifyMeltPreimage(op.invoice!, result.quote.payment_preimage ?? '')
        )
          throw new Error('Payment preimage does not match the invoice.')
        await this.finish(op, [await this.meltChange(wallet, op, result.quote)])
      }
    })
  }
  /** Cancel only an operation that was never submitted to its mint. */
  async cancel(id: string): Promise<void> {
    await this.exclusive(async () => {
      const s = await this.state(),
        op = s.operations.find(o => o.id === id)
      if (!op || op.kind !== 'melt' || op.phase !== 'prepared')
        throw new Error('A submitted payment cannot be cancelled locally.')
      for (const id of op.inputs)
        s.assets.find(a => a.note.id === id)!.note.status = 'ready'
      s.operations = s.operations.filter(o => o.id !== id)
      await this.save(s)
    })
  }
  private async meltChange(
    wallet: CashuWallet,
    op: CashuJournal,
    quote: MeltQuoteBolt11Response
  ): Promise<Proof[]> {
    if (
      String(quote.quote) !== String(op.quote!.quote) ||
      (quote.request && !sameInvoice(quote.request, op.invoice!)) ||
      !Amount.from(quote.amount).equals(
        Amount.from(op.quote!.amount as number)
      ) ||
      !Amount.from(quote.fee_reserve).equals(
        Amount.from(op.quote!.fee_reserve as number)
      )
    )
      throw new Error('Payment quote changed; keep its journal pending.')
    const outputs = op.outputs!.map(OutputData.deserialize)
    const minimum = op.reservedAmount! - op.maximumDebit!
    const maximum =
      op.reservedAmount! -
      Amount.from(op.quote!.amount as number).toNumber() -
      op.inputFee!
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum < 0 ||
      maximum < minimum
    )
      throw new Error('Missing payment change accounting; keep its journal.')
    let change = quote.change
      ? wallet.createMeltChangeProofs(outputs, quote.change)
      : []
    if (!quote.change || sumProofs(change).toNumber() < minimum) {
      const restored = await wallet.mint.restore({
        outputs: outputs.map(o => o.blindedMessage)
      })
      if (
        restored.outputs.length !== restored.signatures.length ||
        new Set(restored.outputs.map(output => output.B_)).size !==
          restored.outputs.length
      )
        throw new Error('Invalid or duplicate restored change outputs.')
      change = restored.outputs.flatMap((output, index) => {
        const original = outputs.find(o => o.blindedMessage.B_ === output.B_)
        if (!original)
          throw new Error('Mint returned an unknown change output.')
        return wallet.createMeltChangeProofs(
          [original],
          [restored.signatures[index]]
        )
      })
    }
    const total = sumProofs(change).toNumber()
    if (total < minimum || total > maximum)
      throw new Error(
        'Payment change is incomplete or exceeds its agreed bounds.'
      )
    const states = await wallet.checkProofsStates(change)
    if (
      states.length !== change.length ||
      states.some(state => state.state !== 'UNSPENT')
    )
      throw new Error(
        'Payment change is spent or pending; keep the journal for reconciliation.'
      )
    return change
  }
  /** Reconcile an operation without regenerating outputs or replaying a payment. */
  async resume(id: string): Promise<void> {
    await this.exclusive(async () => {
      const op = (await this.state()).operations.find(o => o.id === id)
      if (!op || op.phase === 'complete') return
      const wallet = await this.client(op.mint, op.kind === 'melt')
      if (op.kind === 'melt') {
        if (op.phase === 'prepared') return
        const quote = await wallet.checkMeltQuoteBolt11(String(op.quote!.quote))
        if (quote.state !== 'PAID')
          throw new Error('Payment is not settled. Its inputs remain reserved.')
        if (!verifyMeltPreimage(op.invoice!, quote.payment_preimage ?? ''))
          throw new Error('Invalid payment preimage.')
        const change = await this.meltChange(wallet, op, quote)
        await this.finish(op, [change])
        return
      }
      if (op.kind === 'mint' && !op.outputs) {
        const quote = await wallet.checkMintQuoteBolt11(String(op.quote!.quote))
        if (quote.request && !sameInvoice(quote.request, op.invoice!))
          throw new Error('Mint quote invoice changed.')
        if (
          quote.pubkey &&
          op.quoteKey &&
          quote.pubkey !==
            bytesToHex(secp256k1.getPublicKey(hexToBytes(op.quoteKey)))
        )
          throw new Error('Mint quote owner changed.')
        for (const field of [
          'updated_at',
          'amount_paid',
          'amount_issued'
        ] as const) {
          const previous = op.quote![field],
            next = quote[field]
          if (
            previous != null &&
            next != null &&
            Amount.from(next).lessThan(String(previous))
          )
            throw new Error('Mint quote accounting moved backwards.')
        }
        op.quote = json(quote) as unknown as Record<string, unknown>
        await this.record(op)
        const amount =
          quote.amount_paid !== undefined
            ? Amount.from(quote.amount_paid)
                .subtract(quote.amount_issued ?? 0)
                .toNumber()
            : quote.state === 'PAID'
              ? decodeBolt11AmountMsat(op.invoice!)! / 1000
              : 0
        if (!amount)
          throw new Error(
            'Funding invoice is not paid or has already been issued. Keep its recovery record.'
          )
        const preview = await wallet.prepareMint('bolt11', amount, quote, {
          privkey: op.quoteKey
        })
        op.outputs = preview.outputData.map(OutputData.serialize)
        op.payload = json(preview.payload) as unknown as Record<string, unknown>
        op.keysetId = preview.keysetId
        op.legacySignature = preview.legacySignature
        op.phase = 'submitted'
        await this.record(op)
        const proofs = await wallet.completeMint(preview)
        await this.finish(op, [proofs])
        return
      }
      const swap = op.swap && deserializeSwapPreview(op.swap)
      const groups = swap
        ? [swap.sendOutputs ?? [], swap.keepOutputs ?? []]
        : [op.outputs!.map(OutputData.deserialize)]
      const outputs = groups.flat()
      const response = await wallet.mint.restore({
        outputs: outputs.map(o => o.blindedMessage)
      })
      if (!response.outputs.length && op.kind === 'mint') {
        const quote = await wallet.checkMintQuoteBolt11(String(op.quote!.quote))
        if (!sameInvoice(quote.request, op.invoice!))
          throw new Error('Mint invoice changed.')
        const available =
          quote.amount_paid != null
            ? Amount.from(quote.amount_paid).subtract(quote.amount_issued ?? 0)
            : Amount.from(
                quote.state === 'PAID'
                  ? decodeBolt11AmountMsat(op.invoice!)! / 1000
                  : 0
              )
        const total = outputs.reduce(
          (n, o) => n.add(o.blindedMessage.amount),
          Amount.from(0)
        )
        if (available.greaterThanOrEqual(total)) {
          op.phase = 'submitted'
          await this.record(op)
          const proofs = await wallet.completeMint({
            method: 'bolt11',
            quote,
            payload:
              op.payload as unknown as import('@cashu/cashu-ts').MintRequest,
            outputData: outputs,
            keysetId: op.keysetId!,
            legacySignature: op.legacySignature
          })
          await this.finish(op, [proofs])
          return
        }
      }
      if (!response.outputs.length && swap) {
        const states = await wallet.checkProofsStates(swap.inputs)
        if (states.every(p => p.state === 'UNSPENT')) {
          // Replay the same persisted outputs, never allocate another counter range.
          op.phase = 'submitted'
          await this.record(op)
          const result = await wallet.completeSwap(swap)
          await this.finish(op, [result.send, result.keep])
          return
        }
      }
      if (response.outputs.length !== outputs.length)
        throw new Error(
          'Mint has not returned all outputs. Keep this operation pending; do not spend its inputs.'
        )
      const restored = new Map(
        response.outputs.map((o, i) => [o.B_, response.signatures[i]])
      )
      const proofGroups = groups.map(group =>
        group.map(o => {
          const sig = restored.get(o.blindedMessage.B_)
          if (!sig) throw new Error('Missing restored output.')
          return OutputData.deserialize(OutputData.serialize(o)).toProof(
            sig,
            wallet.getKeyset(sig.id)
          )
        })
      )
      if (swap?.unselectedProofs?.length)
        proofGroups.push(swap.unselectedProofs)
      const states = await wallet.checkProofsStates(proofGroups.flat())
      if (states.some(p => p.state !== 'UNSPENT'))
        throw new Error(
          'Restored outputs are spent or pending. Their journal remains reserved for reconciliation.'
        )
      await this.finish(op, proofGroups)
    })
  }
  /** Check unshared assets; incoming assets are secured by a fresh swap. */
  async refresh(id: string): Promise<void> {
    const s = await this.state(),
      a = s.assets.find(a => a.note.id === id)
    if (!a) throw new Error('Cashu note not found.')
    const pending = s.operations.find(
      o => o.inputs.includes(id) && o.phase !== 'complete'
    )
    if (pending) return this.resume(pending.id)
    if (a.note.status === 'unverified') return this.transform([id])
    await this.exclusive(async () => {
      const wallet = await this.client(a.note.url),
        states = await wallet.checkProofsStates(deserializeProofs(a.proofs))
      if (states.every(p => p.state === 'SPENT')) a.note.status = 'spent'
      else if (states.some(p => p.state !== 'UNSPENT'))
        throw new Error(
          'Mixed or pending proof states. Keep the stored token for recovery.'
        )
      a.note.updatedAt = Date.now()
      await this.save(s)
    })
  }
  /** Edit collection metadata without granting spendability to shared or pending proofs. */
  async reclaim(id: string): Promise<void> {
    await this.exclusive(async () => {
      const s = await this.state(),
        a = s.assets.find(a => a.note.id === id)
      if (!a || a.note.status !== 'shared')
        throw new Error('Select a previously shared Cashu note.')
      const wallet = await this.client(a.note.url)
      const states = await wallet.checkProofsStates(deserializeProofs(a.proofs))
      if (states.some(p => p.state !== 'UNSPENT'))
        throw new Error('The shared token is spent or pending.')
      a.note.status = 'unverified'
      await this.save(s)
      await this.swap([id])
    })
  }
  /** Edit collection metadata without exposing bearer proofs. */
  async annotate(
    id: string,
    values: Partial<Pick<Note, 'label' | 'designId' | 'hidden'>>
  ): Promise<void> {
    await this.exclusive(async () => {
      const s = await this.state(),
        a = s.assets.find(a => a.note.id === id)
      if (!a) throw new Error('Cashu note not found.')
      if (values.label && values.label.length > 200)
        throw new Error('Label is too long.')
      Object.assign(a.note, values)
      await this.save(s)
    })
  }
  /** Scan a bounded NUT-13 range; results never authorize another writer for the old seed. */
  async recover(
    mint: string,
    options: {start?: number; gapLimit?: number; limit?: number} = {}
  ): Promise<number> {
    return this.exclusive(async () => {
      const first = options.start ?? 0,
        gapLimit = options.gapLimit ?? 300,
        limit = options.limit ?? 10000,
        end = first + limit
      if (
        !Number.isSafeInteger(first) ||
        first < 0 ||
        !Number.isSafeInteger(gapLimit) ||
        gapLimit < 100 ||
        gapLimit > 10000 ||
        !Number.isSafeInteger(limit) ||
        limit < 100 ||
        limit > 1000000 ||
        end > 1000000
      )
        throw new Error('Invalid recovery scan range.')
      const wallet = await this.client(mint),
        base = mintUrl(mint)
      const snapshot = await this.state()
      snapshot.restored = true
      snapshot.scanned = snapshot.scanned.filter(url => url !== base)
      await this.save(snapshot)
      let added = 0
      for (const keyset of wallet.keyChain.getKeysets()) {
        if (keyset.unit !== 'sat') continue
        let empty = 0
        for (let start = first; start < end; start += 100) {
          const count = Math.min(100, end - start)
          const recovered = await wallet.restore(start, count, {
            keysetId: keyset.id
          })
          const states = await wallet.checkProofsStates(recovered.proofs)
          const s = await this.state(),
            known = new Set(
              s.assets.flatMap(a =>
                deserializeProofs(a.proofs).map(p => p.secret)
              )
            )
          const fresh = recovered.proofs.filter(
            (p, i) => states[i].state === 'UNSPENT' && !known.has(p.secret)
          )
          if (fresh.length) {
            s.assets.push(asset(base, fresh, 'unverified'))
            added += fresh.length
          }
          if (recovered.lastCounterWithSignature !== undefined)
            s.counters[keyset.id] = Math.max(
              s.counters[keyset.id] ?? 0,
              recovered.lastCounterWithSignature + 1
            )
          await this.save(s)
          empty = recovered.proofs.length ? 0 : empty + count
          if (
            empty >= gapLimit &&
            start + count >= (snapshot.counters[keyset.id] ?? 0)
          )
            break
          if (start + count === end)
            throw new Error(
              `Recovery scan limit reached. Continue from counter ${end}; recovered proofs remain blocked for new outputs.`
            )
        }
      }
      return added
    })
  }
}

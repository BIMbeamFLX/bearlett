import {
  deserializeProofs,
  serializeProofs,
  sumProofs,
  OutputData,
  deserializeSwapPreview
} from '@cashu/cashu-ts'
import type {
  Proof,
  SerializedOutputData,
  SerializedSwapPreview
} from '@cashu/cashu-ts'
import type {Note} from '../vault'
import {mintUrl} from './transport'

export type CashuAsset = {note: Note; proofs: string[]}
export type CashuJournal = {
  id: string
  mint: string
  kind: 'swap' | 'mint' | 'melt'
  phase: 'prepared' | 'submitted' | 'complete'
  inputs: string[]
  createdAt: number
  quote?: Record<string, unknown>
  invoice?: string
  quoteKey?: string
  swap?: SerializedSwapPreview
  outputs?: SerializedOutputData[]
  payload?: Record<string, unknown>
  keysetId?: string
  legacySignature?: string
  receivedIds: string[]
  error?: string
  inputFee?: number
  maximumDebit?: number
  reservedAmount?: number
}
export type CashuState = {
  version: 1
  seed: string
  counters: Record<string, number>
  quoteCounter: number
  assets: CashuAsset[]
  operations: CashuJournal[]
  restored: boolean
  scanned: string[]
}

/** Construct a display note without exposing its proofs in the collection. */
export function asset(
  mint: string,
  proofs: Proof[],
  status: Note['status'] = 'ready'
): CashuAsset {
  const amount = sumProofs(proofs).toNumber() * 1000
  if (!Number.isSafeInteger(amount))
    throw new Error('Amount exceeds wallet precision.')
  return {
    proofs: serializeProofs(proofs),
    note: {
      id: crypto.randomUUID(),
      protocol: 'cashu',
      url: mintUrl(mint),
      amount,
      status,
      updatedAt: Date.now(),
      reason:
        status === 'ready'
          ? 'Cashu proofs received from mint.'
          : 'Awaiting mint verification.'
    }
  }
}

/** Validate recovery records before imported data can influence counters or spending. */
export function validateCashuState(
  value: unknown
): asserts value is CashuState {
  const s = value as CashuState
  if (
    !s ||
    s.version !== 1 ||
    !/^[0-9a-f]{128}$/.test(s.seed) ||
    !Array.isArray(s.assets) ||
    !Array.isArray(s.operations) ||
    !s.counters ||
    typeof s.counters !== 'object' ||
    Array.isArray(s.counters) ||
    !Number.isSafeInteger(s.quoteCounter) ||
    s.quoteCounter < 0 ||
    typeof s.restored !== 'boolean' ||
    !Array.isArray(s.scanned)
  )
    throw new Error('Invalid Cashu recovery state.')
  for (const next of Object.values(s.counters))
    if (!Number.isSafeInteger(next) || next < 0)
      throw new Error('Invalid Cashu counter.')
  const ids = new Set<string>(),
    active = new Set<string>()
  for (const a of s.assets) {
    if (
      !a.note ||
      !/^[\w-]{1,80}$/.test(a.note.id) ||
      ids.has(a.note.id) ||
      a.note.protocol !== 'cashu' ||
      !['unverified', 'ready', 'pending', 'spent', 'shared'].includes(
        a.note.status
      )
    )
      throw new Error('Invalid Cashu asset.')
    ids.add(a.note.id)
    const proofs = deserializeProofs(a.proofs)
    if (
      !proofs.length ||
      proofs.length > 2048 ||
      !Number.isSafeInteger(a.note.amount) ||
      a.note.amount <= 0 ||
      sumProofs(proofs).toNumber() * 1000 !== a.note.amount
    )
      throw new Error('Cashu asset amount mismatch.')
    const mint = mintUrl(a.note.url)
    for (const p of proofs) {
      if (p.secret.trimStart().startsWith('['))
        throw new Error('Locked Cashu proofs are not supported.')
      const amount = p.amount.toBigInt()
      if (
        amount <= 0n ||
        (amount & (amount - 1n)) !== 0n ||
        p.secret.length > 512 ||
        !/^(02|03)[0-9a-f]{64}$/i.test(p.C)
      )
        throw new Error('Invalid Cashu proof.')
      if (a.note.status !== 'spent') {
        const key = mint + ':' + p.secret
        if (active.has(key)) throw new Error('Duplicate Cashu proof.')
        active.add(key)
      }
    }
  }
  const operations = new Set<string>()
  for (const op of s.operations) {
    if (
      !op ||
      !/^[\w-]{1,80}$/.test(op.id) ||
      operations.has(op.id) ||
      !['swap', 'mint', 'melt'].includes(op.kind) ||
      !['prepared', 'submitted', 'complete'].includes(op.phase) ||
      !Array.isArray(op.inputs) ||
      !Array.isArray(op.receivedIds) ||
      new Set(op.inputs).size !== op.inputs.length ||
      op.inputs.some(id => !ids.has(id)) ||
      op.receivedIds.some(id => !ids.has(id))
    )
      throw new Error('Invalid Cashu journal.')
    mintUrl(op.mint)
    operations.add(op.id)
    op.outputs?.forEach(OutputData.deserialize)
    if (op.kind === 'swap' && !op.swap)
      throw new Error('Missing swap recovery data.')
    const inputs = op.inputs.flatMap(id => {
      const a = s.assets.find(a => a.note.id === id)!
      if (a.note.url !== op.mint)
        throw new Error('Operation inputs belong to a different mint.')
      return a.proofs
    })
    if (op.swap) {
      const swap = deserializeSwapPreview(op.swap)
      const actual = serializeProofs([
        ...swap.inputs,
        ...(swap.unselectedProofs ?? [])
      ]).sort()
      if (JSON.stringify(actual) !== JSON.stringify([...inputs].sort()))
        throw new Error('Swap input journal mismatch.')
    }
    if (op.kind === 'mint' && op.inputs.length)
      throw new Error('Minting cannot consume existing assets.')
    if (op.kind === 'mint' && op.outputs) {
      const payload = op.payload as
        | {
            quote?: string
            outputs?: {B_: string; id: string; amount: unknown}[]
          }
        | undefined
      const outputs = op.outputs
        .map(OutputData.deserialize)
        .map(o => o.blindedMessage)
      if (
        !payload ||
        payload.quote !== op.quote?.quote ||
        !Array.isArray(payload.outputs) ||
        payload.outputs.length !== outputs.length ||
        payload.outputs.some(
          (o, i) =>
            o.B_ !== outputs[i].B_ ||
            o.id !== outputs[i].id ||
            String(o.amount) !== outputs[i].amount.toString()
        )
      )
        throw new Error('Mint output journal mismatch.')
    }
    if (op.kind === 'melt' && (!op.outputs || !op.keysetId))
      throw new Error('Missing melt recovery data.')
    if (op.quoteKey && !/^[0-9a-f]{64}$/.test(op.quoteKey))
      throw new Error('Invalid quote key.')
    if (
      op.kind !== 'swap' &&
      (!op.quote || typeof op.quote.quote !== 'string' || !op.invoice)
    )
      throw new Error('Missing quote recovery data.')
  }
}

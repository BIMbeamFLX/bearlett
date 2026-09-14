/**
 * Moving the device's cards to the account, one journaled step at a time.
 *
 * Before account seeds, every device generated its own random mnemonic. Once
 * the shell hands over the account's seed, the cards in that random wallet
 * belong under the account's key, where the account's key image restores them.
 * Nothing moves silently: the holder presses one button, and from then on the
 * move survives a closed window, a lost answer and a crash.
 *
 * Each card goes through the mint twice. The old wallet trades it to the
 * account's address, then the account wallet imports it, which also re-issues
 * it to the account's own deterministic outputs so NUT-09 can find it again.
 * Every step is written to the journal before the mint is asked to do it, so a
 * move that stopped is resumed from what the journal and the old wallet say,
 * never guessed. The screen switches wallets only after every card has been
 * confirmed under the account's key.
 *
 * Only a random wallet is ever moved, and only to the account whose seed is
 * present. Cards under one account's key are never moved to another account.
 *
 * This module is pure over the operations it is given; `session.ts` supplies
 * them from the card library.
 */

export type MigrationCard = {
  /** The proof's secret: how the card library finds the card. */
  secret: string
  /** The asset binding the mint signed into the card. */
  binding: string
  asset_id: string
}

export type MigrationStep = MigrationCard & {
  state: 'planned' | 'trading' | 'traded' | 'importing' | 'gone'
  /** How many sent transfers the old wallet held when this trade began. */
  outgoingBefore?: number
  /** The card, traded to the account's address, until it is imported. */
  token?: string
}

export type MigrationJournal = {
  v: 1
  kind: typeof JOURNAL_KIND
  /** The account wallet's address; every trade goes there and nowhere else. */
  destination: string
  /** Cards the account wallet held before the first import, by binding. */
  held?: Record<string, string[]>
  steps: MigrationStep[]
}

export type OldWallet = {
  pending?: {type?: string; input_secret?: string} | null
  outgoing?: ReadonlyArray<{token: string}>
}

export type MigrationOps = {
  /** Write the journal. Called before every step that reaches the mint. */
  save(journal: MigrationJournal): Promise<void>
  /** The old wallet as stored, without asking the mint. */
  oldWallet(): Promise<OldWallet | null>
  /** Cards the mint says are unspent in the old wallet. */
  oldCards(): Promise<MigrationCard[]>
  /** Trade one card from the old wallet to an address; the card's token. */
  trade(secret: string, destination: string): Promise<string>
  /** Finish the old wallet's interrupted trade; the card's token. */
  finishTrade(): Promise<string>
  /** Read a single-card token without the mint, or null. */
  cardOf(token: string): MigrationCard | null
  /** Import a card into the account wallet. */
  importCard(token: string): Promise<void>
  /** Cards the mint says are unspent under the account wallet's key. */
  newCards(): Promise<MigrationCard[]>
}

export const JOURNAL_KIND = 'bearlett/nutft-migration'

/** The card library's words for a token it already took in. */
export const ALREADY_TAKEN =
  /token is already in this wallet|token is spent or not addressed to this wallet/

const SAID = {
  busy: 'The device wallet is finishing another transfer. Try again in a moment.',
  unconfirmed:
    'Some cards are not yet confirmed under your account, so nothing was switched. Try again.',
  failed:
    'Moving your cards stopped before it finished. Nothing is lost: it continues where it stopped when you try again.',
  damaged:
    'The record of an unfinished move cannot be read. Nothing was changed. Ask for help before trying again.',
  elsewhere:
    'Some cards are being moved to another account. Open this collection from that account to finish the move.'
} as const

/** A move that stopped, in a fixed sentence: never a token, secret or seed. */
export class MigrationStopped extends Error {
  constructor(readonly reason: keyof typeof SAID) {
    super(SAID[reason])
    this.name = 'MigrationStopped'
  }
}

export const planMigration = (
  destination: string,
  cards: readonly MigrationCard[]
): MigrationJournal => ({
  v: 1,
  kind: JOURNAL_KIND,
  destination,
  steps: cards.map(({secret, binding, asset_id}) => ({
    secret,
    binding,
    asset_id,
    state: 'planned'
  }))
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const HEX64 = /^[0-9a-f]{64}$/
const STATES = ['planned', 'trading', 'traded', 'importing', 'gone']

const isStep = (value: unknown): value is MigrationStep =>
  isRecord(value) &&
  typeof value.secret === 'string' &&
  value.secret.length > 0 &&
  value.secret.length <= 4096 &&
  typeof value.binding === 'string' &&
  HEX64.test(value.binding) &&
  typeof value.asset_id === 'string' &&
  value.asset_id.length > 0 &&
  value.asset_id.length <= 64 &&
  STATES.includes(value.state as string) &&
  (value.outgoingBefore === undefined ||
    (Number.isSafeInteger(value.outgoingBefore) &&
      (value.outgoingBefore as number) >= 0)) &&
  (['traded', 'importing'].includes(value.state as string)
    ? typeof value.token === 'string' && value.token.length > 0
    : value.token === undefined)

/**
 * Read a journal strictly. A journal decides where cards go, so one that is not
 * exactly what this module writes is refused, not repaired.
 */
export function parseMigrationJournal(value: unknown): MigrationJournal {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.kind !== JOURNAL_KIND ||
    typeof value.destination !== 'string' ||
    !/^0[23][0-9a-f]{64}$/.test(value.destination) ||
    !Array.isArray(value.steps) ||
    !value.steps.every(isStep)
  )
    throw new MigrationStopped('damaged')
  const held = value.held
  if (
    held !== undefined &&
    !(
      isRecord(held) &&
      Object.entries(held).every(
        ([binding, secrets]) =>
          HEX64.test(binding) &&
          Array.isArray(secrets) &&
          secrets.every(secret => typeof secret === 'string')
      )
    )
  )
    throw new MigrationStopped('damaged')
  const steps = value.steps as MigrationStep[]
  if (held === undefined && steps.some(step => step.state === 'importing'))
    throw new MigrationStopped('damaged')
  return value as MigrationJournal
}

const heldBy = (cards: readonly MigrationCard[]): Record<string, string[]> => {
  const held: Record<string, string[]> = {}
  for (const card of cards) (held[card.binding] ??= []).push(card.secret)
  return held
}

/* Read as a property: the card library may run in another realm, where its
   errors are not instances of this realm's Error. */
const messageOf = (error: unknown): string => {
  const message = (error as {message?: unknown} | null)?.message
  return typeof message === 'string' ? message : ''
}

/**
 * Run a journal to the end, or stop with a fixed sentence.
 *
 * Resolves only once every card that was not already gone is confirmed under
 * the account's key, which is when the caller may switch wallets.
 */
export async function runMigration(
  journal: MigrationJournal,
  ops: MigrationOps,
  progress?: (done: number, total: number) => void
): Promise<{moved: number; gone: number}> {
  try {
    return await run(journal, ops, progress)
  } catch (error) {
    if (error instanceof MigrationStopped) throw error
    /* The library's and the shell's own words stay here: whatever they say,
       the holder hears one sentence that carries nothing from the wallet. */
    throw new MigrationStopped('failed')
  }
}

async function run(
  journal: MigrationJournal,
  ops: MigrationOps,
  progress?: (done: number, total: number) => void
): Promise<{moved: number; gone: number}> {
  const total = journal.steps.length
  let done = 0
  let stillOld: Set<string> | null = null

  /* Where the trade of one card stands, and the token when it is done. `null`
     means the card left the old wallet by some other way and cannot be moved;
     only a card with no pending trade, no new sent transfer and no unspent
     proof left in the old wallet is called that. */
  const trade = async (step: MigrationStep): Promise<string | null> => {
    const old = await ops.oldWallet()
    const outgoing = old?.outgoing ?? []
    if (old?.pending) {
      const ours =
        step.state === 'trading' &&
        old.pending.type === 'trade' &&
        old.pending.input_secret === step.secret
      if (!ours) throw new MigrationStopped('busy')
      return ops.finishTrade()
    }
    if (step.state === 'trading') {
      const sent = outgoing[0]?.token
      if (
        sent &&
        step.outgoingBefore !== undefined &&
        outgoing.length > step.outgoingBefore &&
        ops.cardOf(sent)?.binding === step.binding
      )
        return sent
      stillOld ??= new Set((await ops.oldCards()).map(card => card.secret))
      if (!stillOld.has(step.secret)) return null
    }
    step.state = 'trading'
    step.outgoingBefore = outgoing.length
    await ops.save(journal)
    return ops.trade(step.secret, journal.destination)
  }

  for (const step of journal.steps) {
    if (step.state === 'planned' || step.state === 'trading') {
      const token = await trade(step)
      delete step.outgoingBefore
      if (token === null) {
        step.state = 'gone'
        await ops.save(journal)
        progress?.(++done, total)
        continue
      }
      step.token = token
      step.state = 'traded'
      await ops.save(journal)
    }
    if (step.state === 'traded') {
      journal.held ??= heldBy(await ops.newCards())
      step.state = 'importing'
      await ops.save(journal)
    }
    if (step.state === 'importing') {
      try {
        await ops.importCard(step.token!)
      } catch (error) {
        /* An import that landed before the move stopped. Confirmation below
           counts the card either way. */
        if (!ALREADY_TAKEN.test(messageOf(error))) throw error
      }
    }
    progress?.(++done, total)
  }

  const moving = journal.steps.filter(step => step.state !== 'gone')
  if (moving.length) {
    /* Each moved card adds exactly one unspent proof under the account's key
       that was not there before the first import, whether it is the traded
       proof or its re-issue. Nothing else writes to the account wallet while
       its move is open, so fewer new proofs than moved cards means a card is
       not confirmed, and the switch waits. */
    const held = journal.held ?? {}
    const fresh = new Map<string, number>()
    for (const card of await ops.newCards())
      if (!held[card.binding]?.includes(card.secret))
        fresh.set(card.binding, (fresh.get(card.binding) ?? 0) + 1)
    const wanted = new Map<string, number>()
    for (const step of moving)
      wanted.set(step.binding, (wanted.get(step.binding) ?? 0) + 1)
    for (const [binding, count] of wanted)
      if ((fresh.get(binding) ?? 0) < count)
        throw new MigrationStopped('unconfirmed')
  }
  return {moved: moving.length, gone: total - moving.length}
}

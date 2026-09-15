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
 * account's address, then the account wallet takes it in and re-issues it to
 * its own deterministic outputs, so NUT-09 can find it again. Every step is
 * written to the journal before the mint is asked to do it, so a move that
 * stopped is resumed from what the journal, the old wallet and the mint say,
 * never guessed.
 *
 * A traded card is recognised by its lock, not by where it sits in a list: a
 * one-card token in the old wallet's sent transfers, locked to the account's
 * key, with the step's card binding, and not already another step's. A card
 * is given up as gone only when no such token exists and the mint says its
 * proof is spent, or the proof has left the old wallet. A step is confirmed on
 * its own, once the mint says its traded proof is spent, which only the
 * account's re-issue does; the screen switches wallets only after every step
 * that is not gone is confirmed.
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
  state: 'planned' | 'trading' | 'traded' | 'importing' | 'confirmed' | 'gone'
  /** The card, traded to the account's address, once it is known. */
  token?: string
}

export type MigrationJournal = {
  v: 1
  kind: typeof JOURNAL_KIND
  /** The account wallet's address; every trade goes there and nowhere else. */
  destination: string
  steps: MigrationStep[]
}

/** The old wallet as stored, read without the mint. */
export type OldWallet = {
  /** Secrets of the proofs its tokens hold. */
  held: ReadonlySet<string>
  pending?: {type?: string; input_secret?: string} | null
  /** Its sent transfers, newest first. */
  outgoing: readonly string[]
}

/** A one-card token, read without the mint. */
export type TradedCard = MigrationCard & {
  /** Locked to the account's key: a move's token, and nobody else's. */
  toDestination: boolean
}

export type MigrationOps = {
  /** Write the journal. Called before every step that reaches the mint. */
  save(journal: MigrationJournal): Promise<void>
  oldWallet(): Promise<OldWallet>
  /** What the mint says about proofs; throws when it could not be asked. */
  states(secrets: readonly string[]): Promise<Map<string, 'UNSPENT' | 'SPENT'>>
  /** Trade one card from the old wallet to an address; the card's token. */
  trade(secret: string, destination: string): Promise<string>
  /** Finish the old wallet's interrupted trade; the card's token. */
  finishTrade(): Promise<string>
  cardOf(token: string): TradedCard | null
  /**
   * Take a traded card into the account wallet and onto its own outputs.
   * Resolves once the mint says the traded proof is spent, and rejects while
   * it is not, so the step can be tried again.
   */
  settle(token: string): Promise<void>
}

export const JOURNAL_KIND = 'bearlett/nutft-migration'

const SAID = {
  busy: 'The device wallet is finishing another transfer. Try again in a moment.',
  unconfirmed:
    'Some cards are not yet confirmed under your account, so nothing was switched. Try again.',
  failed:
    'Moving your cards stopped before it finished. Nothing is lost: it continues where it stopped when you try again.',
  damaged:
    'The record of an unfinished move cannot be read. Nothing was changed. Ask for help before trying again.',
  elsewhere:
    'Some cards are being moved to another account. Open this collection from that account to finish the move.',
  foreign:
    'The wallet on this device is not the one your cards were moved from, so nothing is moved from it.'
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
const STATES = [
  'planned',
  'trading',
  'traded',
  'importing',
  'confirmed',
  'gone'
]
const WITH_TOKEN = ['traded', 'importing', 'confirmed']

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
  (WITH_TOKEN.includes(value.state as string)
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
  const tokens = value.steps
    .map(step => (step as MigrationStep).token)
    .filter(token => token !== undefined)
  if (new Set(tokens).size !== tokens.length)
    throw new MigrationStopped('damaged')
  return value as MigrationJournal
}

/**
 * Run a journal to the end, or stop with a fixed sentence.
 *
 * Resolves only once every step is confirmed or gone, which is when the caller
 * may switch wallets.
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
  let done = 0

  /* The old wallet's sent transfers that are a move's token for this card,
     newest first, and not already another step's. */
  const tokenFor = (step: MigrationStep, old: OldWallet): string | null => {
    const claimed = new Set(journal.steps.map(other => other.token))
    for (const token of old.outgoing) {
      if (claimed.has(token)) continue
      const card = ops.cardOf(token)
      if (card?.toDestination && card.binding === step.binding) return token
    }
    return null
  }

  /* Where the trade of one card stands, and its token once it is done. `null`
     means the card left the old wallet some other way and cannot be moved. */
  const trade = async (step: MigrationStep): Promise<string | null> => {
    const old = await ops.oldWallet()
    if (old.pending) {
      const ours =
        step.state === 'trading' &&
        old.pending.type === 'trade' &&
        old.pending.input_secret === step.secret
      if (!ours) throw new MigrationStopped('busy')
      return ops.finishTrade()
    }
    const held = old.held.has(step.secret)
    if (step.state === 'trading' || !held) {
      /* Still held and unspent: the trade never went through, so it is asked
         for again. Otherwise it went through, or the card went another way,
         and only its token can tell which. */
      const unspent =
        held && (await ops.states([step.secret])).get(step.secret) === 'UNSPENT'
      if (!unspent) return tokenFor(step, old)
    }
    step.state = 'trading'
    await ops.save(journal)
    return ops.trade(step.secret, journal.destination)
  }

  const advance = async (step: MigrationStep): Promise<void> => {
    if (step.state === 'planned' || step.state === 'trading') {
      const token = await trade(step)
      if (token === null) {
        step.state = 'gone'
        await ops.save(journal)
        return
      }
      const card = ops.cardOf(token)
      if (!card?.toDestination || card.binding !== step.binding)
        throw new MigrationStopped('damaged')
      step.token = token
      step.state = 'traded'
      await ops.save(journal)
    }
    if (step.state === 'traded') {
      step.state = 'importing'
      await ops.save(journal)
    }
    if (step.state === 'importing') {
      await ops.settle(step.token!)
      step.state = 'confirmed'
      await ops.save(journal)
    }
  }

  for (let index = 0; index < journal.steps.length; index += 1) {
    await advance(journal.steps[index])
    progress?.(++done, journal.steps.length)
  }

  /* A move's token that no step claims, left in the old wallet's sent
     transfers by an earlier stop, is still a card for the account. It is taken
     in too, rather than left where nothing would ever show it again. */
  const claimed = new Set(journal.steps.map(step => step.token))
  const strays = (await ops.oldWallet()).outgoing.flatMap(token => {
    const card = claimed.has(token) ? null : ops.cardOf(token)
    return card?.toDestination ? [{token, card}] : []
  })
  if (strays.length) {
    const added: MigrationStep[] = strays.map(({token, card}) => ({
      secret: card.secret,
      binding: card.binding,
      asset_id: card.asset_id,
      state: 'importing',
      token
    }))
    journal.steps.push(...added)
    await ops.save(journal)
    for (const step of added) {
      await advance(step)
      progress?.(++done, journal.steps.length)
    }
  }

  return {
    moved: journal.steps.filter(step => step.state === 'confirmed').length,
    gone: journal.steps.filter(step => step.state === 'gone').length
  }
}

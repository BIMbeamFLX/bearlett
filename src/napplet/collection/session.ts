import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'
import type {CollectionEdition, NutFTWalletApi} from './bootstrap'
import {isIncomplete} from './cards'
import type {Snapshot} from './cards'
import {
  MigrationStopped,
  parseMigrationJournal,
  planMigration,
  runMigration
} from './migration'
import type {MigrationCard, MigrationJournal, MigrationOps} from './migration'
import {
  ReceiveProblem,
  checkLockedTo,
  readCardToken,
  receiveProblem
} from './receive'
import type {CardToken} from './receive'
import {sealedWith} from './sealed'
import {hostMnemonic, seedFingerprint, seededWallet} from './seed'
import type {KeyTools, SeedCrypto, SeededWallet} from './seed'
import {decodeCards, encodeCards} from './tokens'
import type {CardProof, TokenCodec} from './tokens'
import {
  WalletUnreadable,
  hostWalletKey,
  migrationKey,
  readWallet,
  storageKeyFor,
  writeWallet
} from './wallets'
import type {StoredWallet, WalletSlots, WalletStore} from './wallets'

/**
 * One open collection, and the wallets behind it.
 *
 * Without an account seed this is the collection as it always was: one wallet
 * with a random mnemonic. With one, the account's wallet is opened under its
 * fingerprint, created from the seed before the card library can generate a
 * key of its own, and restored from the mint on a device that has never held
 * it. The device's random wallet is never switched away from while it still
 * holds cards; moving them is a deliberate step, and the switch comes only
 * once every card is confirmed under the account's key.
 *
 * A card taken in is not counted as held for good until it sits on the
 * wallet's own deterministic outputs, the only outputs a restore from its seed
 * can find. Until then its secret waits in the wallet's own list and every
 * refresh tries its re-issue again.
 *
 * Every wallet call goes through one queue and names the wallet it is for, so
 * the library's single storage key is never re-pointed in the middle of an
 * operation.
 */

export type WalletRole = 'random' | 'host'

export type Opening = {
  /** The wallet the screen shows. */
  active: WalletRole
  /** The account's wallet has not yet been restored on this device. */
  restore: boolean
  /**
   * `offer`: the random wallet holds cards that can move to this account.
   * `resume`: a move to this account stopped and continues.
   * `elsewhere`: a move to another account is unfinished and is left alone.
   */
  migration: 'none' | 'offer' | 'resume' | 'elsewhere'
  /** Cards the random wallet still holds, or the cards a stopped move has. */
  cards: number
}

/** The parts of cashu-ts a session reads tokens with. */
export type TokenTools = KeyTools &
  TokenCodec & {
    getTokenMetadata(token: string): {
      mint: string
      unit: string
      incompleteProofs: ReadonlyArray<{
        secret: string
        amount: unknown
        p2pk_e?: string
      }>
    }
    maybeDeriveP2BKPrivateKeys(
      privateKey: string,
      proof: {secret: string; p2pk_e?: string}
    ): string[]
    hashToCurve(secret: Uint8Array): {toHex(compressed?: boolean): string}
  }

export type SessionDeps = {
  edition: CollectionEdition
  /** The shell's storage, sealed where a wallet asked for it. */
  store: WalletStore
  /** The router the card library was given as its storage. */
  slots: WalletSlots
  wallet: NutFTWalletApi
  cashu: TokenTools
  crypto: SeedCrypto
  /** The collection's router to its mint, the same door the library uses. */
  fetch: typeof fetch
  /** The account's seed from the lease, already checked. */
  seed?: string
}

/** A step that stopped, said in a sentence that carries no secret. */
export class SessionProblem extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionProblem'
  }
}

export const RESTORE_WAITING =
  'Restoring your cards is waiting for the mint. It continues by itself, and nothing is lost in between.'
export const MINT_UNASKED =
  'The mint could not confirm your cards just now. Nothing was changed; try again.'
export const MOVE_OPEN =
  'Cards on this device are being moved to an account. Nothing here can be handed over or cleared until that move has finished.'
export const NOT_A_HANDOVER =
  'That token belongs to your own wallets, not to a card you handed over, so it stays.'
const NOT_OPEN = 'The collection is not open yet.'
const NO_ACCOUNT =
  'Cards can only be moved once the collection is opened from your account.'

/* Read as a property: the card library may run in another realm, where its
   errors are not instances of this realm's Error. */
const messageOf = (error: unknown): string => {
  const message = (error as {message?: unknown} | null)?.message
  return typeof message === 'string' ? message : ''
}

/* The binding and asset of a card, read from its proof secret. */
const tagOf = (secret: string): {binding: string; asset_id: string} | null => {
  try {
    const tags = JSON.parse(secret)?.[1]?.tags
    const tag = Array.isArray(tags)
      ? tags.find(
          (entry: unknown) => Array.isArray(entry) && entry[0] === 'nutft'
        )
      : null
    return tag && /^[0-9a-f]{64}$/.test(tag[5]) && typeof tag[3] === 'string'
      ? {binding: tag[5], asset_id: tag[3]}
      : null
  } catch {
    return null
  }
}

const cardsOf = (snapshot: Snapshot): MigrationCard[] =>
  snapshot.owned.flatMap(item => {
    const secret = (item.proof as {secret?: unknown} | undefined)?.secret
    const tag = typeof secret === 'string' ? tagOf(secret) : null
    return tag ? [{secret: secret as string, ...tag}] : []
  })

/* A snapshot that holds cards the mint was not asked about decides nothing. */
const complete = (snapshot: Snapshot): Snapshot => {
  if (isIncomplete(snapshot)) throw new SessionProblem(MINT_UNASKED)
  return snapshot
}

const tokenOf = (result: unknown): string => {
  const token = (result as {token?: unknown} | null)?.token
  if (typeof token !== 'string') throw new MigrationStopped('failed')
  return token
}

/* What a restore writes into before its cards join the wallet: nothing. */
const EMPTY: StoredWallet = {
  privateKey: '',
  pubkey: '',
  seedPhrase: '',
  counters: {},
  tokens: [],
  outgoing: [],
  pending: null
}

/* What a move writes beside the wallets: whose move it is, in the clear, and
   the journal itself sealed for that account. A finished move keeps only the
   first half. */
type JournalRecord = {v: 1; to: string; box?: string; finished?: true}

export type CollectionSession = ReturnType<typeof openSession>

export function openSession(deps: SessionDeps) {
  const {edition, store, slots, wallet, cashu, crypto} = deps
  const fetcher = deps.fetch
  /* A seed is checked whether or not this build uses it: a malformed one
     refuses to open in the alpha build exactly as it would with account
     wallets on. Only a build with account wallets goes on to use it. */
  if (deps.seed !== undefined && !isHostSeed(deps.seed)) throw new UnsafeLease()
  const seed = edition.accountWallets === true ? deps.seed : undefined
  const randomKey = storageKeyFor(edition)
  const journalKey = migrationKey(edition)
  const account =
    seed === undefined
      ? null
      : (() => {
          const fingerprint = seedFingerprint(seed)
          const key = hostWalletKey(edition, fingerprint)
          return {
            fingerprint,
            key,
            /* Where a restore lands before its cards join the wallet. */
            restoreKey: `${key}:restore`,
            codec: sealedWith(seed)
          }
        })()
  /* Sealed from the first write: the account wallet is never stored in the
     clear, and a clear value found under its key is refused, not read. */
  if (account) {
    store.protect(account.key, account.codec)
    store.protect(account.restoreKey, account.codec)
  }

  let words: string | null = null
  let derived: SeededWallet | null = null
  const mnemonic = (): string =>
    (words ??= hostMnemonic(seed!, edition.id, crypto))
  const seeded = (): SeededWallet =>
    (derived ??= seededWallet(mnemonic(), crypto, cashu))

  let active: WalletRole = 'random'
  let opened = false

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  /* The library keeps the last wallet it read in memory, and falls back to it
     when storage holds nothing. So a switch is checked: afterwards the library
     must read the wallet stored under the new key, and a key with nothing
     stored is only usable by a library that has never read another wallet. */
  const point = async (key: string): Promise<void> => {
    const stored = await readWallet(store, key)
    slots.select(key)
    const seen = (await wallet.read()) as {pubkey?: unknown} | null
    if (stored ? seen?.pubkey !== stored.pubkey : Boolean(seen?.pubkey))
      throw new WalletUnreadable()
  }

  const on = <T>(key: string, work: () => Promise<T>): Promise<T> =>
    serial(async () => {
      if (!opened) throw new SessionProblem(NOT_OPEN)
      await point(key)
      return work()
    })

  const activeKey = (): string => (active === 'host' ? account!.key : randomKey)

  /* Written before the library is ever pointed at the account's key, so the
     account's wallet has the seed's key from the start and the library never
     generates a random one there. */
  const createAccountWallet = async (): Promise<StoredWallet> => {
    const created: StoredWallet = {
      ...seeded(),
      seedSource: 'host',
      restore: 'pending'
    }
    await writeWallet(store, account!.key, created)
    return created
  }

  /* A stored account wallet must hold the key its seed derives. Anything else
     is not this account's wallet, whatever put it there, and nothing is done
     with it. */
  const checkAccountWallet = async (
    stored: StoredWallet
  ): Promise<StoredWallet> => {
    const expected = seeded()
    if (
      stored.privateKey !== expected.privateKey ||
      stored.pubkey !== expected.pubkey ||
      stored.seedSource === 'random'
    )
      throw new UnsafeLease()
    if (stored.seedSource === 'host') return stored
    /* A restore that finished just before a stamp could be written. */
    const stamped: StoredWallet = {...stored, seedSource: 'host'}
    await writeWallet(store, account!.key, stamped)
    return stamped
  }

  const accountWallet = async (): Promise<StoredWallet> => {
    const stored = await readWallet(store, account!.key)
    return stored ? checkAccountWallet(stored) : createAccountWallet()
  }

  /* Whether every proof of a token is locked to this private key. */
  const lockedTo = (token: string, privateKey: string): boolean => {
    try {
      const {incompleteProofs} = cashu.getTokenMetadata(token)
      return (
        incompleteProofs.length > 0 &&
        incompleteProofs.every(
          proof =>
            typeof proof.p2pk_e === 'string' &&
            cashu.maybeDeriveP2BKPrivateKeys(privateKey, proof).length > 0
        )
      )
    } catch {
      return false
    }
  }

  /* The proofs a list of tokens holds, read offline. A token this collection
     cannot take apart is left out, as the card library leaves it out. */
  const proofsIn = (tokens: readonly string[]): CardProof[] =>
    tokens.flatMap(token => {
      try {
        return decodeCards(token, cashu).proofs
      } catch {
        return []
      }
    })

  const secretsIn = (tokens: readonly string[]): Set<string> =>
    new Set(proofsIn(tokens).map(proof => proof.secret))

  /* What the mint says about proofs, by secret. Every one is answered, or the
     whole question fails: a card the mint was not asked about is not spent. */
  const states = async (
    secrets: readonly string[]
  ): Promise<Map<string, 'UNSPENT' | 'SPENT'>> => {
    const answers = new Map<string, 'UNSPENT' | 'SPENT'>()
    for (let offset = 0; offset < secrets.length; offset += 256) {
      const batch = secrets.slice(offset, offset + 256)
      const Ys = batch.map(secret =>
        cashu.hashToCurve(new TextEncoder().encode(secret)).toHex(true)
      )
      let payload: {states?: Array<{Y?: string; state?: string}>}
      try {
        const response = await fetcher(`${edition.mint}/v1/checkstate`, {
          method: 'POST',
          body: JSON.stringify({Ys})
        })
        if (!response.ok) throw new Error('refused')
        payload = await response.json()
      } catch {
        throw new SessionProblem(MINT_UNASKED)
      }
      const answered = payload?.states
      if (!Array.isArray(answered) || answered.length !== batch.length)
        throw new SessionProblem(MINT_UNASKED)
      batch.forEach((secret, index) => {
        const answer = answered[index]
        if (
          answer?.Y !== Ys[index] ||
          (answer.state !== 'UNSPENT' && answer.state !== 'SPENT')
        )
          throw new SessionProblem(MINT_UNASKED)
        answers.set(secret, answer.state)
      })
    }
    return answers
  }

  /* A card this wallet re-issued to itself can be left among its sent
     transfers instead of its tokens: when the answer to that trade is lost, a
     later call finishes it and files it as sent. It is still this wallet's
     card, locked to this wallet's key and already on its own outputs, so it is
     moved back among the tokens, once. */
  const adoptOwn = async (key: string): Promise<boolean> => {
    const state = await readWallet(store, key)
    if (!state?.privateKey) return false
    const own = (state.outgoing ?? []).filter(entry =>
      lockedTo(entry.token, state.privateKey)
    )
    if (!own.length) return false
    const held = secretsIn(state.tokens)
    const tokens = [...state.tokens]
    for (const {token} of own) {
      const proofs = proofsIn([token])
      if (!proofs.length || proofs.some(proof => held.has(proof.secret)))
        continue
      proofs.forEach(proof => held.add(proof.secret))
      tokens.push(token)
    }
    const moved = new Set(own.map(entry => entry.token))
    await writeWallet(store, key, {
      ...state,
      tokens,
      outgoing: (state.outgoing ?? []).filter(entry => !moved.has(entry.token))
    })
    return true
  }

  /**
   * Bring proofs this wallet holds onto its own deterministic outputs. A proof
   * counts as re-issued once the mint says it is spent. Resolves to the
   * secrets that still wait; throws only when the mint could not be asked.
   */
  const reissue = async (
    key: string,
    secrets: readonly string[]
  ): Promise<string[]> => {
    if (!secrets.length) return []
    if ((await readWallet(store, key))?.pending)
      try {
        await wallet.recoverPending()
      } catch {
        /* a refusal drops it; a lost answer keeps it for the next try */
      }
    await adoptOwn(key)
    const first = await states(secrets)
    for (const secret of secrets) {
      if (first.get(secret) === 'SPENT') continue
      const state = await readWallet(store, key)
      if (!state || state.pending || !secretsIn(state.tokens).has(secret))
        continue
      try {
        await wallet.tradeProof(edition.mint, secret, state.pubkey)
      } catch {
        /* refused, or its answer lost: it waits for the next try */
      }
      await adoptOwn(key)
    }
    const after = await states(secrets)
    const held = secretsIn((await readWallet(store, key))?.tokens ?? [])
    return secrets.filter(
      secret => after.get(secret) !== 'SPENT' && held.has(secret)
    )
  }

  /* The wallet's list of secrets that wait for their re-issue, changed. */
  const awaiting = async (
    key: string,
    change: (list: string[]) => string[]
  ): Promise<void> => {
    const state = await readWallet(store, key)
    if (!state) return
    const next = [...new Set(change(state.reissue ?? []))]
    const {reissue: _, ...rest} = state
    await writeWallet(store, key, next.length ? {...rest, reissue: next} : rest)
  }

  const snapshotHere = async (key: string): Promise<Snapshot> => {
    let snapshot = complete((await wallet.snapshot(edition.mint)) as Snapshot)
    let changed = await adoptOwn(key)
    const waiting = (await readWallet(store, key))?.reissue ?? []
    let unrestorable = 0
    if (waiting.length) {
      const owned = new Set(
        snapshot.owned.map(
          item => (item.proof as {secret?: string} | undefined)?.secret
        )
      )
      const candidates = waiting.filter(secret => owned.has(secret))
      let still = candidates
      try {
        still = await reissue(key, candidates)
      } catch {
        /* the mint could not be asked: they stay as they were */
      }
      await awaiting(key, () => still)
      unrestorable = still.length
      changed ||= still.length !== waiting.length
    }
    if (changed)
      snapshot = complete((await wallet.snapshot(edition.mint)) as Snapshot)
    return {...snapshot, unrestorable}
  }

  /* The restored proofs this wallet does not hold yet join it as one token;
     counters only ever move forward. */
  const merge = (current: StoredWallet, restored: StoredWallet) => {
    const held = secretsIn([
      ...current.tokens,
      ...(current.outgoing ?? []).map(entry => entry.token)
    ])
    const fresh: CardProof[] = []
    let unit = ''
    for (const token of restored.tokens)
      try {
        const cards = decodeCards(token, cashu)
        unit = cards.unit
        for (const proof of cards.proofs)
          if (!held.has(proof.secret)) {
            held.add(proof.secret)
            fresh.push(proof)
          }
      } catch {
        /* the library wrote it; one it cannot read back is not added */
      }
    const counters = {...(current.counters ?? {})}
    for (const [name, value] of Object.entries(restored.counters ?? {}))
      counters[name] = Math.max(Number(counters[name] ?? 0), Number(value))
    const {restore: _, ...rest} = current
    const tokens = fresh.length
      ? [
          ...current.tokens,
          encodeCards({mint: edition.mint, unit, proofs: fresh}, cashu)
        ]
      : current.tokens
    return {
      state: {...rest, tokens, counters, seedSource: 'host'} as StoredWallet,
      added: fresh.length
    }
  }

  /* NUT-09 restore from the seed alone, into a slot of its own, so that a card
     received while the restore still waits is neither blocked nor overwritten:
     the restored cards join the wallet beside it. */
  const restoreHere = async (): Promise<number | null> => {
    const host = await accountWallet()
    if (host.restore !== 'pending') return null
    try {
      if (host.pending) {
        await point(account!.key)
        await wallet.recoverPending()
      }
      await writeWallet(store, account!.restoreKey, EMPTY)
      await point(account!.restoreKey)
      await wallet.restoreSeed(edition.mint, mnemonic())
    } catch {
      throw new SessionProblem(RESTORE_WAITING)
    }
    const restored = await readWallet(store, account!.restoreKey)
    if (!restored || restored.pubkey !== seeded().pubkey)
      throw new SessionProblem(RESTORE_WAITING)
    const current = await readWallet(store, account!.key)
    if (!current) throw new SessionProblem(RESTORE_WAITING)
    const {state, added} = merge(current, restored)
    await writeWallet(store, account!.key, state)
    await writeWallet(store, account!.restoreKey, EMPTY)
    return added
  }

  const readRecord = async (): Promise<JournalRecord | null> => {
    const text = await store.getItem(journalKey)
    if (!text) return null
    let record: unknown
    try {
      record = JSON.parse(text)
    } catch {
      throw new MigrationStopped('damaged')
    }
    const r = record as Partial<JournalRecord> | null
    if (
      !r ||
      r.v !== 1 ||
      typeof r.to !== 'string' ||
      !/^[0-9a-f]{16}$/.test(r.to) ||
      (r.finished !== undefined && r.finished !== true) ||
      (r.finished ? r.box !== undefined : typeof r.box !== 'string')
    )
      throw new MigrationStopped('damaged')
    return r.finished ? null : (r as JournalRecord)
  }

  const readJournal = async (
    record: JournalRecord
  ): Promise<MigrationJournal> => {
    let text: string
    try {
      text = await account!.codec.open(record.box!, journalKey)
      return parseMigrationJournal(JSON.parse(text))
    } catch {
      throw new MigrationStopped('damaged')
    }
  }

  /* Whether a move of this device's cards is unfinished, for any account. */
  const moveOpen = async (): Promise<boolean> => Boolean(await readRecord())

  /* Cards the device wallet sent to the account's address and nothing took
     in yet: a move's own token, or a handover the holder made to themselves.
     Neither is listed as a handover, so a move takes them in. */
  const toAccount = (state: StoredWallet | null): number =>
    (state?.outgoing ?? []).filter(entry =>
      lockedTo(entry.token, seeded().privateKey)
    ).length

  /* The wallets whose sent transfers are this holder's: the one on screen,
     and, under an account, the device's own wallet too. */
  const listed = async (): Promise<string[]> => {
    if (active !== 'host') return [randomKey]
    const device = await readWallet(store, randomKey)
    return device?.privateKey ? [account!.key, randomKey] : [account!.key]
  }

  const moveOps: MigrationOps = {
    save: async journal =>
      store.setItem(
        journalKey,
        JSON.stringify({
          v: 1,
          to: account!.fingerprint,
          box: await account!.codec.seal(JSON.stringify(journal), journalKey)
        } satisfies JournalRecord)
      ),
    oldWallet: async () => {
      const state = await readWallet(store, randomKey)
      return {
        held: secretsIn(state?.tokens ?? []),
        pending: state?.pending ?? null,
        outgoing: (state?.outgoing ?? []).map(entry => entry.token)
      }
    },
    states,
    trade: (secret, destination) =>
      on(randomKey, async () =>
        tokenOf(await wallet.tradeProof(edition.mint, secret, destination))
      ),
    finishTrade: () =>
      on(randomKey, async () => tokenOf(await wallet.recoverPending())),
    cardOf: token => {
      try {
        const [proof, ...more] = cashu.getTokenMetadata(token).incompleteProofs
        const tag = proof && !more.length ? tagOf(proof.secret) : null
        return tag
          ? {
              secret: proof.secret,
              ...tag,
              toDestination: lockedTo(token, seeded().privateKey)
            }
          : null
      } catch {
        return null
      }
    },
    settle: token =>
      on(account!.key, async () => {
        const card = moveOps.cardOf(token)
        if (!card?.toDestination) throw new MigrationStopped('damaged')
        const host = await readWallet(store, account!.key)
        if (
          !secretsIn(host?.tokens ?? []).has(card.secret) &&
          (await states([card.secret])).get(card.secret) === 'UNSPENT'
        )
          try {
            await wallet.importToken(edition.mint, token)
          } catch (error) {
            /* Only a card this wallet already holds is passed over here. A
               card it cannot hold is not quietly counted as moved. */
            if (!/token is already in this wallet/.test(messageOf(error)))
              throw error
          }
        /* Confirmed once the traded proof is spent, which is what the
           account's own re-issue does to it; not while the account still
           holds the proof the device made. */
        if ((await reissue(account!.key, [card.secret])).length)
          throw new MigrationStopped('unconfirmed')
      })
  }

  /* The device's cards a move starts from, from a snapshot the mint answered
     in full. */
  const deviceCards = (): Promise<MigrationCard[]> =>
    on(randomKey, async () => {
      const snapshot = (await wallet.snapshot(edition.mint)) as Snapshot
      if (isIncomplete(snapshot)) throw new MigrationStopped('failed')
      return cardsOf(snapshot)
    })

  let moving: Promise<{
    moved: number
    gone: number
    restored: number | null
  }> | null = null

  const move = async (
    progress?: (done: number, total: number) => void
  ): Promise<{moved: number; gone: number; restored: number | null}> => {
    if (!opened) throw new SessionProblem(NOT_OPEN)
    if (!account) throw new SessionProblem(NO_ACCOUNT)
    const record = await readRecord()
    if (record && record.to !== account.fingerprint)
      throw new MigrationStopped('elsewhere')
    /* The account wallet's counters come from the mint before any card is
       re-issued to it. */
    const restored = await serial(restoreHere)
    const host = (await serial(accountWallet)) as StoredWallet
    const device = await readWallet(store, randomKey)
    let journal = record ? await readJournal(record) : null
    if (journal && journal.destination !== host.pubkey)
      throw new MigrationStopped('damaged')
    if (
      !journal &&
      !device?.tokens.length &&
      !device?.pending &&
      !toAccount(device)
    ) {
      /* Nothing on the device to move: nothing is written. */
      active = 'host'
      return {moved: 0, gone: 0, restored}
    }
    if (!journal) {
      journal = planMigration(host.pubkey, await deviceCards())
      await moveOps.save(journal)
    }
    const result = await runMigration(journal, moveOps, progress)
    /* The old wallet filed each move as a card sent. They are confirmed under
       the account now, so they are forgotten there; a token is forgotten only
       once it is checked to be locked to the account, so a handover to
       anyone else can never be. */
    for (const step of journal.steps)
      if (step.state === 'confirmed' && step.token) {
        const token = step.token
        if (!moveOps.cardOf(token)?.toDestination) continue
        await on(randomKey, () => wallet.forgetOutgoing(token))
      }
    await store.setItem(
      journalKey,
      JSON.stringify({
        v: 1,
        to: account.fingerprint,
        finished: true
      } satisfies JournalRecord)
    )
    active = 'host'
    return {...result, restored}
  }

  return {
    get active(): WalletRole {
      return active
    },

    /** Decide which wallet the screen shows, creating the account's if needed. */
    open: (): Promise<Opening> =>
      serial(async () => {
        const decided = async (): Promise<Opening> => {
          const record = await readRecord()
          if (!account)
            return {
              active: 'random',
              restore: false,
              migration: record ? 'elsewhere' : 'none',
              cards: 0
            }
          const stored = await readWallet(store, account.key)
          const host = stored ? await checkAccountWallet(stored) : null
          const restore = !host || host.restore === 'pending'
          if (record?.to === account.fingerprint) {
            const journal = await readJournal(record)
            return {
              active: 'random',
              restore,
              migration: 'resume',
              cards: journal.steps.length
            }
          }
          if (!record) {
            /* Cards still in the device's random wallet keep it on screen
               until they are moved on purpose, and a transfer it has in
               flight is finished first. */
            const random = await readWallet(store, randomKey)
            if (
              random &&
              (random.tokens.length || random.pending || toAccount(random))
            ) {
              await point(randomKey)
              const owned = complete(
                (await wallet.snapshot(edition.mint)) as Snapshot
              ).owned.length
              const cards =
                owned + toAccount(await readWallet(store, randomKey))
              if (cards)
                return {active: 'random', restore, migration: 'offer', cards}
            }
          }
          /* No move for this account. A move toward another account stays
             exactly as it is, and this account gets a wallet of its own. */
          const current = host ?? (await createAccountWallet())
          return {
            active: 'host',
            restore: current.restore === 'pending',
            migration: record ? 'elsewhere' : 'none',
            cards: 0
          }
        }
        const opening = await decided()
        active = opening.active
        opened = true
        return opening
      }),

    /**
     * Restore the account's cards from the mint, NUT-09, from the seed alone.
     * Resolves to the number of cards that joined the wallet, or `null` when
     * there was nothing to do. A restore that stops says it is waiting, and
     * runs again from the start on the next try.
     */
    restore: (): Promise<number | null> =>
      serial(async () => {
        if (!opened) throw new SessionProblem(NOT_OPEN)
        return account ? restoreHere() : null
      }),

    /**
     * Move every unspent card of the device's random wallet to the account,
     * or continue a move that stopped. Switches the screen to the account
     * wallet only when every card is confirmed under the account's key. A
     * second call while one runs gets the same move, not another.
     */
    migrate: (
      progress?: (done: number, total: number) => void
    ): Promise<{moved: number; gone: number; restored: number | null}> =>
      (moving ??= move(progress).finally(() => {
        moving = null
      })),

    /**
     * Whether a move of this device's cards is unfinished, toward any account.
     * While it is, the device wallet neither hands over nor receives.
     */
    moveUnfinished: (): Promise<boolean> => serial(moveOpen),

    /** This wallet's address at this mint, for a sender to hand cards to. */
    destination: (): Promise<string> =>
      on(activeKey(), async () => {
        const pubkey = String(await wallet.destination())
        if (active === 'random') {
          const random = await readWallet(store, randomKey)
          if (random && random.seedSource === undefined)
            await writeWallet(store, randomKey, {
              ...random,
              seedSource: 'random'
            })
        }
        return pubkey
      }),

    /**
     * The wallet on screen, read at the mint. Retries the re-issue of every
     * card that still waits for one, and says how many still do.
     */
    snapshot: (): Promise<Snapshot> => {
      const key = activeKey()
      return on(key, () => snapshotHere(key))
    },

    /**
     * Redeem a card token into the wallet on screen. Everything that can be
     * refused without the mint is refused first; every refusal, the mint's
     * included, is a `ReceiveProblem` that never carries the token.
     */
    receive: (text: string): Promise<number> => {
      let card: CardToken
      try {
        card = readCardToken(text, edition, cashu)
      } catch (error) {
        return Promise.reject(receiveProblem(error))
      }
      const key = activeKey()
      return on(key, async () => {
        if (key === randomKey && (await moveOpen()))
          throw new ReceiveProblem('moving')
        /* A random wallet gets its key on first use; the check needs it. */
        await wallet.destination()
        const state = (await wallet.read()) as StoredWallet
        checkLockedTo(card, state.privateKey, cashu)
        const secrets = card.proofs.map(proof => proof.secret)
        const known = new Set(state.reissue ?? [])
        /* Written before the import, so a card that arrives and is then cut
           off from its re-issue is still tried again on the next refresh. */
        await awaiting(key, list => [...list, ...secrets])
        let count: number
        try {
          count = Number(await wallet.importToken(edition.mint, card.token))
        } catch (error) {
          await awaiting(key, list =>
            list.filter(
              secret => known.has(secret) || !secrets.includes(secret)
            )
          ).catch(() => undefined)
          throw error
        }
        let still = secrets
        try {
          still = await reissue(key, secrets)
        } catch {
          /* the mint could not be asked: every one of them waits */
        }
        await awaiting(key, list =>
          list.filter(
            secret => !secrets.includes(secret) || still.includes(secret)
          )
        ).catch(() => undefined)
        return count
      }).catch(error => Promise.reject(receiveProblem(error)))
    },

    handOver: (
      secret: string,
      recipient: string
    ): Promise<{token?: string}> => {
      const key = activeKey()
      return on(key, async () => {
        if (key === randomKey && (await moveOpen()))
          throw new SessionProblem(MOVE_OPEN)
        return (await wallet.tradeProof(edition.mint, secret, recipient)) as {
          token?: string
        }
      })
    },

    /**
     * Cards handed over and not yet confirmed as passed on, from the wallet on
     * screen and, under an account, from the device's own wallet too. The card
     * library keeps every one in storage from the moment the mint re-binds it,
     * because the token is the only thing that can ever claim that card.
     *
     * Never listed: a card re-issued to its own wallet, and a token locked to
     * the account, which is a move's own token and no handover. While a move of
     * this device's cards is unfinished nothing is listed, since a move toward
     * another account cannot be told apart from a handover here.
     */
    sent: (): Promise<Array<{token: string; at?: string}>> =>
      serial(async () => {
        if (!opened) throw new SessionProblem(NOT_OPEN)
        if (await moveOpen()) return []
        const entries: Array<{token: string; at?: string}> = []
        for (const key of await listed()) {
          const state = await readWallet(store, key)
          if (!state?.privateKey) continue
          for (const {token, at} of state.outgoing ?? []) {
            if (lockedTo(token, state.privateKey)) continue
            if (account && lockedTo(token, seeded().privateKey)) continue
            entries.push({token, ...(at ? {at} : {})})
          }
        }
        return entries
      }),

    /**
     * Forget handed-over cards the holder says were passed on, from whichever
     * wallet sent them. Refused while a move is unfinished, and for any token
     * locked to one of this holder's own wallets.
     */
    passedOn: (tokens: readonly string[]): Promise<void> =>
      serial(async () => {
        if (!opened) throw new SessionProblem(NOT_OPEN)
        if (await moveOpen()) throw new SessionProblem(MOVE_OPEN)
        const wallets = await listed()
        for (const token of tokens) {
          if (account && lockedTo(token, seeded().privateKey))
            throw new SessionProblem(NOT_A_HANDOVER)
          for (const key of wallets) {
            const state = await readWallet(store, key)
            if (state?.privateKey && lockedTo(token, state.privateKey))
              throw new SessionProblem(NOT_A_HANDOVER)
          }
        }
        for (const key of wallets) {
          const state = await readWallet(store, key)
          const theirs = tokens.filter(token =>
            (state?.outgoing ?? []).some(entry => entry.token === token)
          )
          if (!theirs.length) continue
          await point(key)
          for (const token of theirs) await wallet.forgetOutgoing(token)
        }
      })
  }
}

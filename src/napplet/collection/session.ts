import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'
import type {CollectionEdition, NutFTWalletApi} from './bootstrap'
import {isIncomplete} from './cards'
import type {Snapshot} from './cards'
import {
  ALREADY_TAKEN,
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
import type {TokenCodec} from './tokens'
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
  fetch?: typeof fetch
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

export const RESTORE_FAILED =
  'Your cards could not be restored from the mint. Nothing was lost; try again.'
export const STILL_RESTORING =
  'Your cards are still being restored. Try again once that has finished.'
export const MINT_UNASKED =
  'The mint could not confirm your cards just now. Nothing was changed; try again.'
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

/* What a move writes beside the wallets: whose move it is, in the clear, and
   the journal itself sealed for that account. A finished move keeps only the
   first half. */
type JournalRecord = {v: 1; to: string; box?: string; finished?: true}

export type CollectionSession = ReturnType<typeof openSession>

export function openSession(deps: SessionDeps) {
  const {edition, store, slots, wallet, cashu, crypto} = deps
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
          return {
            fingerprint,
            key: hostWalletKey(edition, fingerprint),
            codec: sealedWith(seed)
          }
        })()
  /* Sealed from the first write: the account wallet is never stored in the
     clear, and a clear value found under its key is refused, not read. */
  if (account) store.protect(account.key, account.codec)

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

  const ready = async (): Promise<void> => {
    if (active !== 'host') return
    if ((await readWallet(store, account!.key))?.restore === 'pending')
      throw new SessionProblem(STILL_RESTORING)
  }

  /* A card this wallet re-issued to itself can be left among the outgoing
     transfers instead of its tokens: when the answer to that trade is lost, a
     later call finishes it and files it as sent. It is still this wallet's
     card, locked to this wallet's key, so it is taken back in. A failure here
     is left for the next refresh rather than hiding the cards already held. */
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

  const adopt = async (): Promise<number> => {
    const state = (await wallet.read()) as StoredWallet
    let taken = 0
    for (const entry of state.outgoing ?? []) {
      if (!lockedTo(entry.token, state.privateKey)) continue
      try {
        taken += Number(await wallet.importToken(edition.mint, entry.token))
      } catch (error) {
        if (!ALREADY_TAKEN.test(messageOf(error))) break
      }
      await wallet.forgetOutgoing(entry.token)
    }
    return taken
  }

  const snapshotHere = async (): Promise<Snapshot> => {
    const first = complete((await wallet.snapshot(edition.mint)) as Snapshot)
    return (await adopt())
      ? complete((await wallet.snapshot(edition.mint)) as Snapshot)
      : first
  }

  const restoreHere = async (): Promise<number | null> => {
    const host = await accountWallet()
    if (host.restore !== 'pending') return null
    await point(account!.key)
    let found: number
    try {
      found = Number(await wallet.restoreSeed(edition.mint, mnemonic()))
    } catch {
      throw new SessionProblem(RESTORE_FAILED)
    }
    /* The library writes a fresh state; ours is added back to it. */
    const restored = await readWallet(store, account!.key)
    if (!restored || restored.restore) throw new SessionProblem(RESTORE_FAILED)
    await writeWallet(store, account!.key, {...restored, seedSource: 'host'})
    return found
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
    oldWallet: () => readWallet(store, randomKey),
    oldCards: () =>
      on(randomKey, async () => {
        const snapshot = (await wallet.snapshot(edition.mint)) as Snapshot
        if (isIncomplete(snapshot)) throw new MigrationStopped('failed')
        return cardsOf(snapshot)
      }),
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
        return tag ? {secret: proof.secret, ...tag} : null
      } catch {
        return null
      }
    },
    importCard: token =>
      on(account!.key, async () => {
        await wallet.importToken(edition.mint, token)
      }),
    newCards: () => on(account!.key, async () => cardsOf(await snapshotHere()))
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
               until they are moved on purpose. */
            const random = await readWallet(store, randomKey)
            if (random?.tokens.length) {
              await point(randomKey)
              const cards = complete(
                (await wallet.snapshot(edition.mint)) as Snapshot
              ).owned.length
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
     * Resolves to the number found, or `null` when there was nothing to do.
     */
    restore: (): Promise<number | null> =>
      serial(async () => {
        if (!opened) throw new SessionProblem(NOT_OPEN)
        return account ? restoreHere() : null
      }),

    /**
     * Move every unspent card of the device's random wallet to the account,
     * or continue a move that stopped. Switches the screen to the account
     * wallet only when every card is confirmed under the account's key.
     */
    migrate: async (
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
      let journal = record ? await readJournal(record) : null
      if (journal && journal.destination !== host.pubkey)
        throw new MigrationStopped('damaged')
      if (!journal) {
        journal = planMigration(host.pubkey, await moveOps.oldCards())
        await moveOps.save(journal)
      }
      const result = await runMigration(journal, moveOps, progress)
      /* The old wallet filed each move as a card sent. They are confirmed
         under the account now, so they are not left to look like handovers
         still waiting to be passed on. */
      for (const step of journal.steps)
        if (step.token) {
          const sent = step.token
          await on(randomKey, () => wallet.forgetOutgoing(sent))
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
    },

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

    snapshot: (): Promise<Snapshot> => on(activeKey(), snapshotHere),

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
      return on(activeKey(), async () => {
        if (
          active === 'host' &&
          (await readWallet(store, account!.key))?.restore === 'pending'
        )
          throw new ReceiveProblem('restoring')
        /* A random wallet gets its key on first use; the check needs it. */
        await wallet.destination()
        const state = (await wallet.read()) as StoredWallet
        checkLockedTo(card, state.privateKey, cashu)
        return Number(await wallet.importToken(edition.mint, card.token))
      }).catch(error => Promise.reject(receiveProblem(error)))
    },

    handOver: (secret: string, recipient: string): Promise<{token?: string}> =>
      on(activeKey(), async () => {
        await ready()
        return (await wallet.tradeProof(edition.mint, secret, recipient)) as {
          token?: string
        }
      }),

    /**
     * Cards handed over from the wallet on screen and not yet confirmed as
     * passed on, newest first. The card library keeps every one in storage
     * from the moment the mint re-binds it, because the token is the only
     * thing that can ever claim that card; a handover that stopped halfway
     * still lists every card it did hand over.
     */
    sent: (): Promise<Array<{token: string; at?: string}>> =>
      on(activeKey(), async () => {
        const state = (await wallet.read()) as StoredWallet
        return (state.outgoing ?? [])
          .filter(entry => !lockedTo(entry.token, state.privateKey))
          .map(({token, at}) => ({token, ...(at ? {at} : {})}))
      }),

    /** Forget handed-over cards the holder says were passed on. */
    passedOn: (tokens: readonly string[]): Promise<void> =>
      on(activeKey(), async () => {
        for (const token of tokens) await wallet.forgetOutgoing(token)
      })
  }
}

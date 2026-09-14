import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'
import type {CollectionEdition, NutFTWalletApi} from './bootstrap'
import type {Snapshot} from './cards'
import {sealedWith} from './sealed'
import {hostMnemonic, seedFingerprint, seededWallet} from './seed'
import type {KeyTools, SeedCrypto, SeededWallet} from './seed'
import {
  WalletUnreadable,
  hostWalletKey,
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
 * holds cards; moving them is a separate, deliberate step.
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
  /** What the device's random wallet needs. */
  migration: 'none' | 'offer' | 'resume' | 'elsewhere'
  /** Unspent cards still in the random wallet when a move is offered. */
  cards: number
}

/** The parts of cashu-ts a session reads tokens with. */
export type TokenTools = KeyTools & {
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
const NOT_OPEN = 'The collection is not open yet.'

/* The card library's words for a token it already took in. */
const ALREADY_TAKEN =
  /token is already in this wallet|token is spent or not addressed to this wallet/

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : ''

export type CollectionSession = ReturnType<typeof openSession>

export function openSession(deps: SessionDeps) {
  const {edition, store, slots, wallet, cashu, crypto} = deps
  if (deps.seed !== undefined && !isHostSeed(deps.seed)) throw new UnsafeLease()
  const seed = deps.seed
  const randomKey = storageKeyFor(edition)
  const account =
    seed === undefined
      ? null
      : {key: hostWalletKey(edition, seedFingerprint(seed))}
  /* Sealed from the first write: the account wallet is never stored in the
     clear, and a clear value found under its key is refused, not read. */
  if (account) store.protect(account.key, sealedWith(seed!))

  let words: string | null = null
  let derived: SeededWallet | null = null
  const mnemonic = (): string => (words ??= hostMnemonic(seed!, crypto))
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
    const first = (await wallet.snapshot(edition.mint)) as Snapshot
    return (await adopt())
      ? ((await wallet.snapshot(edition.mint)) as Snapshot)
      : first
  }

  return {
    get active(): WalletRole {
      return active
    },

    /** Decide which wallet the screen shows, creating the account's if needed. */
    open: (): Promise<Opening> =>
      serial(async () => {
        const decided = async (): Promise<Opening> => {
          if (!account)
            return {
              active: 'random',
              restore: false,
              migration: 'none',
              cards: 0
            }
          const stored = await readWallet(store, account.key)
          const host = stored ? await checkAccountWallet(stored) : null
          const restore = !host || host.restore === 'pending'
          /* Cards still in the device's random wallet keep it on screen until
             they are moved on purpose. */
          const random = await readWallet(store, randomKey)
          if (random?.tokens.length) {
            await point(randomKey)
            const cards = ((await wallet.snapshot(edition.mint)) as Snapshot)
              .owned.length
            if (cards)
              return {active: 'random', restore, migration: 'offer', cards}
          }
          const current = host ?? (await createAccountWallet())
          return {
            active: 'host',
            restore: current.restore === 'pending',
            migration: 'none',
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
        if (!account) return null
        const stored = await readWallet(store, account.key)
        const host = stored
          ? await checkAccountWallet(stored)
          : await createAccountWallet()
        if (host.restore !== 'pending') return null
        await point(account.key)
        let found: number
        try {
          found = Number(await wallet.restoreSeed(edition.mint, mnemonic()))
        } catch {
          throw new SessionProblem(RESTORE_FAILED)
        }
        /* The library writes a fresh state; ours is added back to it. */
        const restored = await readWallet(store, account.key)
        if (!restored || restored.restore)
          throw new SessionProblem(RESTORE_FAILED)
        await writeWallet(store, account.key, {...restored, seedSource: 'host'})
        return found
      }),

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

    handOver: (secret: string, recipient: string): Promise<{token?: string}> =>
      on(activeKey(), async () => {
        await ready()
        return (await wallet.tradeProof(edition.mint, secret, recipient)) as {
          token?: string
        }
      })
  }
}

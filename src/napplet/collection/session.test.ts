import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import vm from 'node:vm'
import {UNSAFE_OPEN_MESSAGE} from '../../host/nutft-contract'
import type {NutftOperation} from '../../host/nutft-contract'
import {
  ACCOUNT_A,
  ACCOUNT_B,
  FRIEND,
  RANDOM_KEY,
  TestNutftMint,
  accountKey,
  cashu,
  addressOf,
  device,
  fingerprint,
  rateLimit,
  refuseJournalAfterTrade,
  secretOf,
  unreachable,
  watchConsole
} from './harness'
import {MigrationStopped} from './migration'
import {ReceiveProblem} from './receive'
import {MOVE_OPEN, NOT_A_HANDOVER} from './session'
import {decodeCards, encodeCards} from './tokens'
import {WalletUnreadable} from './wallets'

/* Every console method: nothing on these paths may write to any of them. */
let heard: ReturnType<typeof watchConsole>
beforeEach(() => {
  heard = watchConsole()
})
afterEach(() => {
  heard.restore()
  expect(heard.said).toEqual([])
})

/* An account wallet at a mint that has never seen it has nothing to restore;
   the tests that are not about restoring skip that minute of arithmetic. */
const markRestored = async (phone: ReturnType<typeof device>, seed: string) => {
  const {restore, ...state} = await phone.state(accountKey(seed), seed)
  expect(restore).toBe('pending')
  await phone.store(accountKey(seed), state, seed)
}

describe('a build without account wallets', () => {
  const alpha = (mint: TestNutftMint) => device(mint, {accountWallets: false})

  it('opens the device wallet for a valid seed, and creates nothing for the account', async () => {
    const mint = new TestNutftMint()
    const phone = alpha(mint)
    const first = phone.open()
    await first.session.open()
    const address = await first.session.destination()
    await first.wallet.importToken(mint.url, mint.issue(address, 2))
    const before = new Map(phone.storage.map)

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'none',
      cards: 0
    })
    expect(await session.restore()).toBeNull()
    expect(await session.destination()).toBe(address)
    expect((await session.snapshot()).owned).toHaveLength(1)
    await expect(session.migrate()).rejects.toThrow(/opened from your account/)
    /* No account key, no sealed state, no journal: only the device wallet. */
    const keys = [...phone.storage.map.keys()]
    expect(keys.filter(key => key.startsWith(RANDOM_KEY))).toEqual([RANDOM_KEY])
    expect(keys.some(key => key.includes(fingerprint(ACCOUNT_A)))).toBe(false)
    expect(phone.storage.map.get(RANDOM_KEY)).toBe(before.get(RANDOM_KEY))
  })

  it('still refuses a malformed seed with the fixed sentence', () => {
    const mint = new TestNutftMint()
    const phone = alpha(mint)
    for (const seed of ['', ACCOUNT_A.toUpperCase(), ACCOUNT_A.slice(1)])
      expect(() => phone.open(seed)).toThrow(UNSAFE_OPEN_MESSAGE)
    expect(phone.storage.map.size).toBe(0)
  })
})

describe('a collection without an account seed', () => {
  it('keeps the random wallet, and records that it is random', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session} = phone.open()
    expect(await session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'none',
      cards: 0
    })
    const address = await session.destination()
    const stored = await phone.state(RANDOM_KEY)
    expect(stored.pubkey).toBe(address)
    expect(stored.seedSource).toBe('random')
    expect(stored.seedPhrase.split(' ')).toHaveLength(12)
    expect([...phone.storage.map.keys()]).toEqual([RANDOM_KEY])
  })
})

describe('a collection with an account seed', () => {
  it('opens the account wallet under its fingerprint, on the seed key', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'none',
      cards: 0
    })
    const {pubkey, words} = addressOf(ACCOUNT_A)
    expect(await phone.state(accountKey(ACCOUNT_A), ACCOUNT_A)).toMatchObject({
      pubkey,
      seedSource: 'host',
      restore: 'pending',
      tokens: []
    })
    expect(await session.destination()).toBe(pubkey)
    /* No random wallet is made, and no key names the seed. */
    expect([...phone.storage.map.keys()]).toEqual([accountKey(ACCOUNT_A)])
    /* At rest the account wallet is sealed: no key, no word, no seed. */
    const sealed = phone.storage.map.get(accountKey(ACCOUNT_A))!
    for (const secret of [pubkey, ACCOUNT_A, words.split(' ')[0] + ' '])
      expect(sealed).not.toContain(secret)
    expect(JSON.parse(sealed)).toMatchObject({v: 1, alg: 'A256GCM'})
  })

  it('refuses an account wallet stored in the clear', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const first = phone.open(ACCOUNT_A)
    await first.session.open()
    const clear = await phone.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    await phone.store(accountKey(ACCOUNT_A), clear)
    const {session} = phone.open(ACCOUNT_A)
    await expect(session.open()).rejects.toThrow(WalletUnreadable)
  })

  it('restores the account cards on a new device, words never shown', async () => {
    const mint = new TestNutftMint()
    const first = device(mint)
    const one = first.open(ACCOUNT_A)
    await one.session.open()
    await markRestored(first, ACCOUNT_A)
    const address = await one.session.destination()
    /* Imported cards are re-issued to the account's own deterministic
       outputs, which is what makes them restorable from the seed. */
    expect(await one.wallet.importToken(mint.url, mint.issue(address, 2))).toBe(
      1
    )
    expect(await one.wallet.importToken(mint.url, mint.issue(address, 0))).toBe(
      1
    )
    expect((await one.session.snapshot()).owned).toHaveLength(2)

    const operations: NutftOperation[] = []
    const second = device(mint, {
      observe: operation => operations.push(operation)
    })
    const two = second.open(ACCOUNT_A)
    expect(await two.session.open()).toMatchObject({
      active: 'host',
      restore: true
    })
    expect(await two.session.restore()).toBe(2)
    /* Progress can be counted from the restore batches the mint answers. */
    expect(
      operations.filter(name => name === 'restore').length
    ).toBeGreaterThan(2)
    const restored = await second.state(accountKey(ACCOUNT_A), ACCOUNT_A)
    /* The library derived the key again on its own and landed on ours. */
    expect(restored.pubkey).toBe(address)
    expect(restored.seedSource).toBe('host')
    expect(restored.restore).toBeUndefined()
    expect((await two.session.snapshot()).owned).toHaveLength(2)
    expect(await two.session.restore()).toBeNull()
  }, 60000)

  it('gives a second account its own wallet and leaves the first alone', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    await markRestored(phone, ACCOUNT_A)
    const addressA = await a.session.destination()
    await a.wallet.importToken(mint.url, mint.issue(addressA, 1))
    const before = phone.storage.map.get(accountKey(ACCOUNT_A))

    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'none',
      cards: 0
    })
    expect(await b.session.destination()).toBe(addressOf(ACCOUNT_B).pubkey)
    expect(phone.storage.map.get(accountKey(ACCOUNT_A))).toBe(before)
    expect(
      (await phone.state(accountKey(ACCOUNT_B), ACCOUNT_B)).tokens
    ).toEqual([])
    /* Account B cannot even open account A's wallet. */
    await expect(phone.state(accountKey(ACCOUNT_A), ACCOUNT_B)).rejects.toThrow(
      WalletUnreadable
    )
  })

  it('keeps the random wallet on screen while it still holds cards', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const old = phone.open()
    await old.session.open()
    const address = await old.session.destination()
    await old.wallet.importToken(mint.url, mint.issue(address, 3))

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: true,
      migration: 'offer',
      cards: 1
    })
    expect(await session.destination()).toBe(address)
    expect((await session.snapshot()).owned).toHaveLength(1)
    /* Nothing is created for the account until the cards are moved. */
    expect(phone.storage.map.has(accountKey(ACCOUNT_A))).toBe(false)
  })

  it('refuses an account wallet that does not hold the seed key', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const other = addressOf(ACCOUNT_B)
    await phone.store(
      accountKey(ACCOUNT_A),
      {
        privateKey: '77'.repeat(32),
        pubkey: other.pubkey,
        seedPhrase: other.words,
        counters: {},
        tokens: [],
        seedSource: 'host'
      },
      ACCOUNT_A
    )
    const {session} = phone.open(ACCOUNT_A)
    await expect(session.open()).rejects.toThrow(UNSAFE_OPEN_MESSAGE)
    await expect(session.destination()).rejects.toThrow()
  })

  it('refuses a seed that is not 64 lowercase hex before anything opens', () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    for (const seed of ['', ACCOUNT_A.toUpperCase(), ACCOUNT_A.slice(1)])
      expect(() => phone.open(seed)).toThrow(UNSAFE_OPEN_MESSAGE)
  })
})

describe('a card re-issued to itself when the answer was lost', () => {
  it('is taken back in instead of sitting among the sent transfers', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session, wallet} = phone.open()
    await session.open()
    const address = await session.destination()
    /* The re-issue trade commits at the mint and its answer never arrives. */
    mint.lost = 'trade'
    expect(await wallet.importToken(mint.url, mint.issue(address, 1))).toBe(1)
    expect((await phone.state(RANDOM_KEY)).pending).toBeTruthy()

    const snapshot = await session.snapshot()
    expect(snapshot.owned).toHaveLength(1)
    const state = await phone.state(RANDOM_KEY)
    expect(state.pending).toBeFalsy()
    expect(state.outgoing).toEqual([])
    expect(state.tokens).toHaveLength(1)
  })
})

describe('receiving a card', () => {
  const said = (error: unknown) =>
    `${(error as Error).message} ${(error as Error).stack}`

  it('redeems a card sent to this address, and refuses the rest before the mint', async () => {
    const mint = new TestNutftMint()
    const {session} = device(mint).open()
    await session.open()
    const address = await session.destination()
    const asked = () => mint.calls.length

    const before = asked()
    const foreign = new TestNutftMint({url: 'https://other.test/e1'}).issue(
      address
    )
    const other = await session.receive(foreign).catch(error => error)
    expect(other).toBeInstanceOf(ReceiveProblem)
    expect(other.message).toBe('This card belongs to a different mint.')
    expect(said(other)).not.toContain(foreign.slice(0, 30))

    const theirs = mint.issue(addressOf(ACCOUNT_B).pubkey, 2)
    const locked = await session.receive(theirs).catch(error => error)
    expect(locked.reason).toBe('locked')
    expect(said(locked)).not.toContain(theirs.slice(0, 30))
    /* Neither refusal reached the mint. */
    expect(asked()).toBe(before)

    const card = mint.issue(address, 2)
    expect(await session.receive(`  ${card}\n`)).toBe(1)
    expect((await session.snapshot()).owned).toHaveLength(1)

    /* The imported proof was re-issued, so the same token is spent now. */
    const again = await session.receive(card).catch(error => error)
    expect(again.reason).toBe('spent')
    expect(said(again)).not.toContain(card.slice(0, 30))
  })

  it('redeems a token that spells the mint with a trailing slash', async () => {
    const mint = new TestNutftMint()
    const {session} = device(mint).open()
    await session.open()
    const issued = mint.issue(await session.destination(), 3)
    const slashed = encodeCards(
      {...decodeCards(issued, cashu), mint: `${mint.url}/`},
      cashu
    )
    expect(await session.receive(slashed)).toBe(1)
    expect((await session.snapshot()).owned).toHaveLength(1)
  })

  it('says the mint could not be reached without saying the token', async () => {
    const mint = new TestNutftMint()
    const {session} = device(mint).open()
    await session.open()
    const card = mint.issue(await session.destination(), 1)
    const answer = unreachable(mint, 'checkstate')
    const outcome = await session.receive(card).catch(error => error)
    answer()
    expect(outcome).toBeInstanceOf(ReceiveProblem)
    expect(said(outcome)).not.toContain(card.slice(0, 30))
    expect((await session.snapshot()).owned).toEqual([])
  })

  it('keeps a card waiting for its re-issue, and tries again on refresh', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    const {session} = phone.open()
    await session.open()
    const address = await session.destination()
    const card = mint.issue(address, 1)
    /* Every re-issue is refused while the mint is busy. */
    const busy = rateLimit(mint, 'trade', () => true)
    expect(await session.receive(card)).toBe(1)
    const waiting = await phone.state(RANDOM_KEY)
    expect(waiting.reissue).toHaveLength(1)
    const [secret] = waiting.reissue
    let snapshot = await session.snapshot()
    expect(snapshot.owned).toHaveLength(1)
    expect(snapshot.unrestorable).toBe(1)
    /* The held proof is still the one the sender made. */
    expect(secretOf(snapshot.owned[0])).toBe(secret)

    busy()
    snapshot = await session.snapshot()
    expect(snapshot.unrestorable).toBe(0)
    expect(snapshot.owned).toHaveLength(1)
    expect(secretOf(snapshot.owned[0])).not.toBe(secret)
    expect((await phone.state(RANDOM_KEY)).reissue).toBeUndefined()
  })
})

/* A device that has used the collection before account seeds existed. */
const deviceWithCards = async (mint: TestNutftMint, cards: number[]) => {
  const phone = device(mint)
  const old = phone.open()
  await old.session.open()
  const address = await old.session.destination()
  for (const card of cards)
    await old.wallet.importToken(mint.url, mint.issue(address, card))
  return {phone, address}
}

/* The account wallet as a device that already restored it would hold it. */
const restoredAccount = async (
  phone: ReturnType<typeof device>,
  seed: string
) => {
  const {words, pubkey, privateKey} = addressOf(seed)
  await phone.store(
    accountKey(seed),
    {
      privateKey,
      pubkey,
      seedPhrase: words,
      counters: {},
      tokens: [],
      outgoing: [],
      pending: null,
      seedSource: 'host'
    },
    seed
  )
}

const MIGRATION_KEY = `${RANDOM_KEY}:migration`

describe('handing cards over', () => {
  it('keeps every handed-over card until the holder says it was passed on', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    const first = phone.open()
    await first.session.open()
    const secrets = (await first.session.snapshot()).owned.map(
      item => (item.proof as {secret: string}).secret
    )
    const recipient = addressOf(ACCOUNT_B).pubkey
    const handed = await first.session.handOver(secrets[0], recipient)
    expect(handed.token).toMatch(/^cashuB/)
    /* The second handover stops before the mint answers. */
    mint.before = 'trade'
    await expect(
      first.session.handOver(secrets[1], recipient)
    ).rejects.toThrow()
    expect(await first.session.sent()).toEqual([
      {token: handed.token, at: expect.any(String)}
    ])

    /* The window closes. Nothing handed over is lost with it, and the
       interrupted handover is finished and listed the next time round. */
    const second = phone.open()
    await second.session.open()
    await second.session.snapshot()
    const sent = await second.session.sent()
    expect(sent).toHaveLength(2)
    expect(sent.map(entry => entry.token)).toContain(handed.token)

    await second.session.passedOn(sent.map(entry => entry.token))
    expect(await second.session.sent()).toEqual([])
    expect((await second.session.snapshot()).owned).toEqual([])
  })
})

describe('moving the device cards to the account', () => {
  it('moves them, switches after confirming, and a new device restores them', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 3])

    /* Record the order of journal writes and mint trades. */
    const order: string[] = []
    const write = phone.storage.setItem
    phone.storage.setItem = async (key, value) => {
      if (key === MIGRATION_KEY) order.push('journal')
      return write(key, value)
    }
    const ask = mint.request.bind(mint)
    mint.request = async request => {
      if (request.operation === 'trade') order.push('trade')
      return ask(request)
    }

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: true,
      migration: 'offer',
      cards: 2
    })
    const progress: string[] = []
    expect(
      await session.migrate((done, total) => progress.push(`${done}/${total}`))
    ).toEqual({moved: 2, gone: 0, restored: 0})
    expect(progress).toEqual(['1/2', '2/2'])
    expect(session.active).toBe('host')
    expect(order[0]).toBe('journal')
    expect(order.indexOf('journal')).toBeLessThan(order.indexOf('trade'))

    expect(await session.destination()).toBe(addressOf(ACCOUNT_A).pubkey)
    expect((await session.snapshot()).owned).toHaveLength(2)
    expect((await phone.state(RANDOM_KEY)).tokens).toEqual([])
    /* The moves are not left behind as handovers waiting to be passed on. */
    expect((await phone.state(RANDOM_KEY)).outgoing).toEqual([])
    expect(await session.sent()).toEqual([])
    /* A finished move leaves no journal and no token behind. */
    expect(JSON.parse(phone.storage.map.get(MIGRATION_KEY)!)).toEqual({
      v: 1,
      to: fingerprint(ACCOUNT_A),
      finished: true
    })

    /* The next open shows the account wallet and offers nothing. */
    const again = phone.open(ACCOUNT_A)
    expect(await again.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })

    /* And the account's key image brings the moved cards back elsewhere. */
    const laptop = device(mint)
    const elsewhere = laptop.open(ACCOUNT_A)
    await elsewhere.session.open()
    expect(await elsewhere.session.restore()).toBe(2)
  }, 60000)

  it('resumes a move that stopped when the window closed', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [0, 2])
    await restoredAccount(phone, ACCOUNT_A)

    const first = phone.open(ACCOUNT_A)
    expect(await first.session.open()).toMatchObject({migration: 'offer'})
    /* The first trade commits at the mint; its answer never arrives. */
    mint.lost = 'trade'
    const stopped = await first.session.migrate().catch(error => error)
    expect(stopped).toBeInstanceOf(MigrationStopped)
    expect(stopped.message).not.toMatch(/cashu|nonce|P2PK/)
    expect(first.session.active).toBe('random')
    /* The journal names the account, and keeps the rest sealed. */
    const record = JSON.parse(phone.storage.map.get(MIGRATION_KEY)!)
    expect(record.to).toBe(fingerprint(ACCOUNT_A))
    expect(record.box).not.toMatch(/cashu|trading|nonce/)

    const second = phone.open(ACCOUNT_A)
    expect(await second.session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'resume',
      cards: 2
    })
    expect(await second.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await second.session.snapshot()).owned).toHaveLength(2)
    expect((await phone.state(RANDOM_KEY)).tokens).toEqual([])
  })

  it('never moves one account wallet into another', async () => {
    const mint = new TestNutftMint()
    const phone = device(mint)
    await restoredAccount(phone, ACCOUNT_A)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    const addressA = await a.session.destination()
    await a.wallet.importToken(mint.url, mint.issue(addressA, 1))
    const before = phone.storage.map.get(accountKey(ACCOUNT_A))

    await restoredAccount(phone, ACCOUNT_B)
    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })
    expect(await b.session.migrate()).toEqual({
      moved: 0,
      gone: 0,
      restored: null
    })
    expect(phone.storage.map.get(accountKey(ACCOUNT_A))).toBe(before)
    /* Nothing to move, so nothing about a move is written either. */
    expect(phone.storage.map.has(MIGRATION_KEY)).toBe(false)
    expect((await b.session.snapshot()).owned).toEqual([])
    expect(mint.calls.filter(call => call.operation === 'trade')).toHaveLength(
      1
    )
  })

  it('leaves a move toward another account alone', async () => {
    const mint = new TestNutftMint()
    const {phone, address} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const a = phone.open(ACCOUNT_A)
    await a.session.open()
    mint.before = 'trade'
    await expect(a.session.migrate()).rejects.toThrow(MigrationStopped)
    const journal = phone.storage.map.get(MIGRATION_KEY)
    const random = phone.storage.map.get(RANDOM_KEY)

    const b = phone.open(ACCOUNT_B)
    expect(await b.session.open()).toEqual({
      active: 'host',
      restore: true,
      migration: 'elsewhere',
      cards: 0
    })
    await expect(b.session.migrate()).rejects.toThrow(/another account/)
    expect(phone.storage.map.get(MIGRATION_KEY)).toBe(journal)
    expect(phone.storage.map.get(RANDOM_KEY)).toBe(random)

    /* Without any seed the device wallet stays on screen, and says why the
       move is not offered. */
    const none = phone.open()
    expect(await none.session.open()).toMatchObject({
      active: 'random',
      migration: 'elsewhere'
    })
    expect(await none.session.destination()).toBe(address)
  })
})

/* An error made in another realm, the way the card library's errors reach
   the session in a napplet. */
const foreignError = (message: string): unknown =>
  vm.runInContext(`new Error(${JSON.stringify(message)})`, vm.createContext({}))

const tradesAt = (mint: TestNutftMint) =>
  mint.calls.filter(call => call.operation === 'trade').length

describe('a move and the wallets around it', () => {
  it('runs one move when it is asked for twice at once', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    await restoredAccount(phone, ACCOUNT_A)
    const {session} = phone.open(ACCOUNT_A)
    await session.open()
    const trades = tradesAt(mint)
    const first = session.migrate()
    const second = session.migrate()
    expect(second).toBe(first)
    expect(await first).toEqual({moved: 2, gone: 0, restored: null})
    /* Each card: one trade to the account, and its re-issue there. */
    expect(tradesAt(mint) - trades).toBe(4)
  })

  it('takes in a card the device wallet handed to the account, and never lists it', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1, 2])
    const old = phone.open()
    await old.session.open()
    const [first] = (await old.session.snapshot()).owned
    const {token} = await old.session.handOver(
      secretOf(first),
      addressOf(ACCOUNT_A).pubkey
    )
    await restoredAccount(phone, ACCOUNT_A)

    const {session} = phone.open(ACCOUNT_A)
    expect(await session.open()).toEqual({
      active: 'random',
      restore: false,
      migration: 'offer',
      cards: 2
    })
    expect(await session.sent()).toEqual([])
    await expect(session.passedOn([token!])).rejects.toThrow(NOT_A_HANDOVER)
    expect(await session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await session.snapshot()).owned).toHaveLength(2)
    expect((await phone.state(RANDOM_KEY)).outgoing).toEqual([])
  })

  it('passes over a card the account already took in, told so from another realm', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    const importToken = ui.wallet.importToken
    ui.wallet.importToken = async (mintUrl, token) => {
      ui.wallet.importToken = importToken
      await importToken(mintUrl, token)
      throw foreignError('token is already in this wallet')
    }
    expect(await ui.session.migrate()).toEqual({
      moved: 1,
      gone: 0,
      restored: null
    })
    expect((await ui.session.snapshot()).owned).toHaveLength(1)
  })

  it('stops instead of counting a card the account could not take in', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1])
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    const importToken = ui.wallet.importToken
    ui.wallet.importToken = async () => {
      ui.wallet.importToken = importToken
      throw foreignError('token is spent or not addressed to this wallet')
    }
    const stopped = await ui.session.migrate().catch(error => error)
    expect(stopped).toBeInstanceOf(MigrationStopped)
    expect(ui.session.active).toBe('random')
    expect(await ui.session.moveUnfinished()).toBe(true)

    expect(await ui.session.migrate()).toEqual({
      moved: 1,
      gone: 0,
      restored: null
    })
    expect(await ui.session.moveUnfinished()).toBe(false)
  })

  it('finishes a device handover whose answer was lost, and lists it under the account', async () => {
    const mint = new TestNutftMint()
    const {phone} = await deviceWithCards(mint, [1])
    const old = phone.open()
    await old.session.open()
    const [card] = (await old.session.snapshot()).owned
    mint.lost = 'trade'
    await expect(old.session.handOver(secretOf(card), FRIEND)).rejects.toThrow()
    expect((await phone.state(RANDOM_KEY)).pending).toBeTruthy()
    await restoredAccount(phone, ACCOUNT_A)

    const ui = phone.open(ACCOUNT_A)
    expect(await ui.session.open()).toEqual({
      active: 'host',
      restore: false,
      migration: 'none',
      cards: 0
    })
    expect((await phone.state(RANDOM_KEY)).pending).toBeNull()
    const sent = await ui.session.sent()
    expect(sent).toHaveLength(1)
    await ui.session.passedOn(sent.map(entry => entry.token))
    expect(await ui.session.sent()).toEqual([])
  })

  it('refuses to hand over, receive or pass on from the device wallet while it moves', async () => {
    const mint = new TestNutftMint()
    const {phone, address} = await deviceWithCards(mint, [1, 2, 3])
    const before = phone.open()
    await before.session.open()
    const [first] = (await before.session.snapshot()).owned
    const {token} = await before.session.handOver(secretOf(first), FRIEND)
    await restoredAccount(phone, ACCOUNT_A)
    const ui = phone.open(ACCOUNT_A)
    await ui.session.open()
    /* The move stops after its first trade, with a card still to go. */
    refuseJournalAfterTrade(phone.storage)
    await expect(ui.session.migrate()).rejects.toThrow(MigrationStopped)
    expect(await ui.session.moveUnfinished()).toBe(true)

    const [left] = (await ui.session.snapshot()).owned
    await expect(ui.session.handOver(secretOf(left), FRIEND)).rejects.toThrow(
      MOVE_OPEN
    )
    const refused = await ui.session
      .receive(mint.issue(address, 3))
      .catch(error => error)
    expect(refused).toBeInstanceOf(ReceiveProblem)
    expect(refused.reason).toBe('moving')
    expect(await ui.session.sent()).toEqual([])
    await expect(ui.session.passedOn([token!])).rejects.toThrow(MOVE_OPEN)

    /* Once the move finishes, the handover from before is listed again. */
    expect(await ui.session.migrate()).toEqual({
      moved: 2,
      gone: 0,
      restored: null
    })
    expect((await ui.session.sent()).map(entry => entry.token)).toEqual([token])
  })
})

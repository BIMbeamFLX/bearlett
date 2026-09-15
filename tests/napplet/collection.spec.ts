import {test, expect} from '@playwright/test'
import type {FrameLocator, Page} from '@playwright/test'
import {existsSync, readFileSync} from 'node:fs'

/*
 * The built collection, in the sandboxed srcdoc frame a shell gives it, with
 * the reference NutFT service in front of a fixture mint (scripts/napplet-host.mjs).
 * Build both first:
 *   BEARLETT_MINT=https://tcg.nappelin.com npm run build:collection
 *   BEARLETT_MINT=https://tcg.nappelin.com BEARLETT_ACCOUNT_WALLETS=1 npm run build:collection
 * `/collection` is the alpha build, `/collection-accounts` the one with account
 * wallets.
 */
const ALPHA = 'dist-collection-600b-e1'
const ACCOUNTS = 'dist-collection-600b-e1-accounts'
const DEVICE_WALLET = 'bearlett:nutft:600b-e1'
const ACCOUNT_WALLET = /^bearlett:nutft:600b-e1:[0-9a-f]{16}$/
const UNSAFE =
  'This collection could not be opened safely. Close it and try again.'
const WEBSITE_CARDS =
  "A card bought on tcg.nappelin.com is locked to that site's wallet: send it to your collection's address in the wallet there first, then paste the token into the collection."

declare global {
  interface Window {
    hostCalls: Array<{type: string; operation?: string; topic?: string}>
    hostEmits: Array<{topic: string; payload: unknown}>
    hostStore: Map<string, string>
    collectionMint: {
      url: string
      issue(pubkey: string, card?: number): string
      request(request: {operation: string}): Promise<unknown>
      lost?: string
    }
    BearlettCollectionPreview: {
      TestNutftMint: new (options: {url: string}) => {
        issue(pubkey: string): string
      }
    }
    reloadNapplet(options?: {seed?: string}): void
    deliverNapplet(topic: string, payload: unknown): void
    restoreMint?: () => void
  }
}

const opened = async (page: Page, path = '/collection') => {
  const errors: string[] = []
  const logged: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => logged.push(message.text()))
  await page.goto(path)
  const collection = page.frameLocator('#collection')
  await expect(
    collection.getByRole('heading', {name: 'No cards yet'})
  ).toBeVisible()
  return {collection, errors, logged}
}

const cardsHeld = (collection: FrameLocator) =>
  collection.locator('.counters dd').first()

const addressOf = async (collection: FrameLocator) => {
  await collection.getByRole('button', {name: 'Receive', exact: true}).click()
  const field = collection.getByLabel('Your address in this collection')
  await expect(field).toHaveValue(/^0[23][0-9a-f]{64}$/)
  return field.inputValue()
}

const issue = (page: Page, pubkey: string, card: number) =>
  page.evaluate(
    ([key, n]) => window.collectionMint.issue(key as string, n as number),
    [pubkey, card] as const
  )

const mintOperations = (page: Page) =>
  page.evaluate(() =>
    window.hostCalls
      .filter(call => call.type === 'nutft.request')
      .map(call => call.operation)
  )

const stored = (page: Page, key: string) =>
  page.evaluate(name => window.hostStore.get(name) ?? null, key)

/* The inventory the host would answer with, and the wallet it names. */
const inventory = async (page: Page) => {
  const text = await stored(page, 'inventory')
  return {
    wallet: await stored(page, 'inventory:wallet'),
    cards: text
      ? (JSON.parse(text) as {cards: Array<{count: number}>}).cards
      : null
  }
}

test.describe('the alpha collection', () => {
  test.skip(
    !existsSync(`${ALPHA}/index.html`),
    'Build the collection first: npm run build:collection with BEARLETT_MINT.'
  )

  test('opens in a sandboxed frame where Web Locks are refused', async ({
    page
  }) => {
    const {collection, errors} = await opened(page)
    await expect(
      collection.getByRole('heading', {name: '600B Edition One'})
    ).toBeVisible()
    /* The frame is the kind that refuses the Locks API, so the collection got
       past that step for a reason, not because the browser allowed it. */
    const refusal = await page.evaluate(
      () =>
        new Promise<string>(resolve => {
          const probe = document.createElement('iframe')
          probe.sandbox.add('allow-scripts')
          probe.srcdoc = `<script>navigator.locks.request('probe', async () => 1)
            .then(() => parent.postMessage({probe: 'granted'}, '*'),
                  error => parent.postMessage({probe: error.name}, '*'))<\/script>`
          addEventListener('message', event => {
            if (!event.data?.probe) return
            probe.remove()
            resolve(event.data.probe)
          })
          document.body.append(probe)
        })
    )
    expect(refusal).toBe('SecurityError')
    expect(await mintOperations(page)).toEqual(
      expect.arrayContaining(['info', 'keys'])
    )
    expect(errors).toEqual([])
  })

  test('tells a second tab of the shell that the collection is open', async ({
    page,
    context
  }) => {
    await opened(page)
    const other = await context.newPage()
    await other.goto('/collection')
    const second = other.frameLocator('#collection')
    await expect(
      second.getByText('This collection is already open in another window.')
    ).toBeVisible()

    /* Closing the first tab gives the lease back. */
    await page.close()
    await other.evaluate(() => window.reloadNapplet())
    await expect(
      second.getByRole('heading', {name: 'No cards yet'})
    ).toBeVisible()
  })

  test('declares no receive route in its manifest', () => {
    const manifest = JSON.parse(
      readFileSync(`${ALPHA}/.nip5a-manifest.json`, 'utf8')
    ) as {tags: string[][]}
    const archetypes = manifest.tags
      .filter(tag => tag[0] === 'archetype')
      .map(tag => tag[2])
    expect(archetypes).toEqual([
      'napplet:collection/open',
      'napplet:collection/inventory'
    ])
  })

  test('publishes its inventory with no receive message, and counts a pasted card', async ({
    page
  }) => {
    const {collection, errors} = await opened(page)
    await expect
      .poll(() => inventory(page))
      .toEqual({wallet: DEVICE_WALLET, cards: []})
    const address = await addressOf(collection)
    await expect(collection.getByText(WEBSITE_CARDS)).toBeVisible()
    await collection
      .getByLabel('Card token')
      .fill(await issue(page, address, 1))
    await collection.getByRole('button', {name: 'Redeem'}).click()
    await expect(collection.getByText('Received 1 card.')).toBeVisible()
    await expect
      .poll(async () => (await inventory(page)).cards)
      .toEqual([expect.objectContaining({count: 1})])
    expect(
      await page.evaluate(() =>
        window.hostEmits.some(
          emit => emit.topic === 'napplet:collection/inventory'
        )
      )
    ).toBe(true)
    expect(errors).toEqual([])
  })

  test('redeems a card sent to this address and refuses a foreign one', async ({
    page
  }) => {
    const {collection, errors, logged} = await opened(page)
    const address = await addressOf(collection)
    const field = collection.getByLabel('Card token')
    const redeem = collection.getByRole('button', {name: 'Redeem'})

    const foreign = await page.evaluate(
      pubkey =>
        new window.BearlettCollectionPreview.TestNutftMint({
          url: 'https://other.test/e1'
        }).issue(pubkey),
      address
    )
    const before = (await mintOperations(page)).length
    await field.fill(foreign)
    await redeem.click()
    await expect(
      collection.getByText('This card belongs to a different mint.')
    ).toBeVisible()
    /* No second try changes that, so the token leaves the field. */
    await expect(field).toHaveValue('')
    expect((await mintOperations(page)).length).toBe(before)

    const card = await issue(page, address, 1)
    await field.fill(card)
    await redeem.click()
    await expect(collection.getByText('Received 1 card.')).toBeVisible()
    await expect(field).toHaveValue('')
    await collection.getByRole('button', {name: 'Close'}).click()
    await expect(cardsHeld(collection)).toHaveText('1')
    expect(await mintOperations(page)).toContain('catalog')

    /* The token stayed out of the address bar and the console. */
    expect(page.url()).not.toContain('cashu')
    expect(logged.join('\n')).not.toContain(card.slice(0, 24))
    expect(errors).toEqual([])
  })

  test('keeps a token the mint could not take, and asks before clearing it', async ({
    page
  }) => {
    const {collection, errors} = await opened(page)
    const address = await addressOf(collection)
    const field = collection.getByLabel('Card token')
    const redeem = collection.getByRole('button', {name: 'Redeem'})
    const card = await issue(page, address, 2)

    /* The mint cannot say whether the card is spent, however often asked. */
    await page.evaluate(() => {
      const mint = window.collectionMint
      const ask = mint.request.bind(mint)
      mint.request = async request => {
        if (request.operation === 'checkstate')
          throw new Error('Mint request unavailable, denied, or interrupted.')
        return ask(request)
      }
      window.restoreMint = () => {
        mint.request = ask
      }
    })
    await field.fill(card)
    await redeem.click()
    await expect(
      collection.getByText(
        'The mint could not be reached, so nothing was redeemed. Try again.'
      )
    ).toBeVisible({timeout: 30000})
    await expect(field).toHaveValue(card)

    /* The same token goes through once the mint answers. */
    await page.evaluate(() => window.restoreMint?.())
    await redeem.click()
    await expect(collection.getByText('Received 1 card.')).toBeVisible()
    await expect(field).toHaveValue('')

    /* A token still in the field is not cleared by Close without asking. */
    const next = await issue(page, address, 3)
    await field.fill(next)
    await collection.getByRole('button', {name: 'Close'}).click()
    await expect(
      collection.getByText('This card token is not redeemed.', {exact: false})
    ).toBeVisible()
    await collection.getByRole('button', {name: 'Keep it'}).click()
    await expect(field).toHaveValue(next)
    await collection.getByRole('button', {name: 'Close'}).click()
    await collection.getByRole('button', {name: 'Clear and close'}).click()
    await expect(field).toBeHidden()
    await expect(cardsHeld(collection)).toHaveText('1')
    expect(errors).toEqual([])
  })

  test('lines up cards from other napplets for the holder, one at a time', async ({
    page
  }) => {
    const {collection, errors} = await opened(page)
    const address = await addressOf(collection)
    await collection.getByRole('button', {name: 'Close'}).click()
    const first = await issue(page, address, 2)
    const second = await issue(page, address, 3)
    for (const payload of [
      {token: first},
      {token: 'not a card at all'},
      {token: second},
      {token: first}
    ])
      await page.evaluate(
        value => window.deliverNapplet('napplet:collection/receive', value),
        payload
      )

    const field = collection.getByLabel('Card token')
    await expect(field).toHaveValue(first)
    await expect(field).toBeFocused()
    await expect(
      collection.getByText(
        '1 more card handed over by other napplets waits its turn here.'
      )
    ).toBeVisible()
    await expect(cardsHeld(collection)).toHaveText('0')

    /* Nothing is redeemed until the holder presses Redeem, and the next card
       comes into the field only once the first is in. */
    await collection.getByRole('button', {name: 'Redeem'}).click()
    await expect(field).toHaveValue(second)
    await expect(cardsHeld(collection)).toHaveText('1')
    await collection.getByRole('button', {name: 'Redeem'}).click()
    await expect(collection.getByText('Received 1 card.')).toBeVisible()
    await expect(field).toHaveValue('')
    await expect(cardsHeld(collection)).toHaveText('2')
    expect(errors).toEqual([])
  })

  test('opens the device wallet for a valid seed, and nothing for a malformed one', async ({
    page
  }) => {
    const {collection, errors} = await opened(page)
    await page.evaluate(() => window.reloadNapplet({seed: 'AB'.repeat(32)}))
    await expect(collection.getByText(UNSAFE)).toBeVisible()

    await page.evaluate(() => window.reloadNapplet({seed: '4b'.repeat(32)}))
    await expect(
      collection.getByRole('heading', {name: 'No cards yet'})
    ).toBeVisible()
    await expect
      .poll(() => inventory(page))
      .toEqual({wallet: DEVICE_WALLET, cards: []})
    const keys = await page.evaluate(() => [...window.hostStore.keys()])
    expect(keys.filter(key => ACCOUNT_WALLET.test(key))).toEqual([])
    await expect(
      collection.getByText('Move your cards to your account.')
    ).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

test.describe('the collection with account wallets', () => {
  test.skip(
    !existsSync(`${ACCOUNTS}/index.html`),
    'Build it first: npm run build:collection with BEARLETT_MINT and BEARLETT_ACCOUNT_WALLETS=1.'
  )

  test('seals the account wallet, restores it and publishes its inventory', async ({
    page
  }) => {
    const {collection, errors} = await opened(page, '/collection-accounts')
    await page.evaluate(() => window.reloadNapplet({seed: 'AB'.repeat(32)}))
    await expect(collection.getByText(UNSAFE)).toBeVisible()
    const keys = await page.evaluate(() => [...window.hostStore.keys()])
    expect(keys.filter(key => ACCOUNT_WALLET.test(key))).toEqual([])

    const seed = '4b'.repeat(32)
    await page.evaluate(value => window.reloadNapplet({seed: value}), seed)
    await expect(
      collection.getByText(
        'Nothing to restore: this account holds no cards at this mint yet.'
      )
    ).toBeVisible({timeout: 60000})
    const all = await page.evaluate(() => Object.fromEntries(window.hostStore))
    const account = Object.keys(all).find(key => ACCOUNT_WALLET.test(key))!
    expect(JSON.parse(all[account])).toMatchObject({v: 1, alg: 'A256GCM'})
    expect(all[account]).not.toContain(seed)
    await expect
      .poll(() => inventory(page))
      .toEqual({wallet: account, cards: []})
    expect(errors).toEqual([])
  })

  test('moves the device cards to the account, and holds the device wallet while it moves', async ({
    page
  }) => {
    const {collection, errors} = await opened(page, '/collection-accounts')
    const address = await addressOf(collection)
    await collection
      .getByLabel('Card token')
      .fill(await issue(page, address, 0))
    await collection.getByRole('button', {name: 'Redeem'}).click()
    await expect(collection.getByText('Received 1 card.')).toBeVisible()

    await page.evaluate(() => window.reloadNapplet({seed: '5c'.repeat(32)}))
    await expect(
      collection.getByText('Move your cards to your account.')
    ).toBeVisible({timeout: 60000})
    await expect(cardsHeld(collection)).toHaveText('1')
    await expect
      .poll(() => inventory(page))
      .toEqual({
        wallet: DEVICE_WALLET,
        cards: [expect.objectContaining({count: 1})]
      })

    /* The trade commits at the mint and its answer is lost: the move stops,
       and the device wallet neither receives nor hands over until it ends. */
    await page.evaluate(() => {
      window.collectionMint.lost = 'trade'
    })
    await collection.getByRole('button', {name: 'Move cards'}).click()
    await expect(
      collection.getByText(
        'Cards on this device are being moved to an account.',
        {exact: false}
      )
    ).toBeVisible({timeout: 60000})
    await expect(
      collection.getByRole('button', {name: 'Receive', exact: true})
    ).toBeDisabled()

    await collection.getByRole('button', {name: 'Finish moving'}).click()
    await expect(
      collection.getByText('Moved 1 card to your account.')
    ).toBeVisible({timeout: 60000})
    await expect(cardsHeld(collection)).toHaveText('1')
    await expect(
      collection.getByRole('button', {name: 'Receive', exact: true})
    ).toBeEnabled()
    const random = JSON.parse((await stored(page, DEVICE_WALLET))!)
    expect(random.tokens).toEqual([])
    expect(random.outgoing).toEqual([])
    await expect
      .poll(async () => (await inventory(page)).wallet)
      .toMatch(ACCOUNT_WALLET)
    expect((await inventory(page)).cards).toEqual([
      expect.objectContaining({count: 1})
    ])
    expect(errors).toEqual([])
  })
})

import {test, expect} from '@playwright/test'
import type {Page} from '@playwright/test'
import {existsSync} from 'node:fs'

/*
 * The built collection, in the sandboxed srcdoc frame a shell gives it, with
 * the reference NutFT service in front of a fixture mint (scripts/napplet-host.mjs).
 * Build it first: BEARLETT_MINT=https://tcg.nappelin.com npm run build:collection
 */
test.skip(
  !existsSync('dist-collection-600b-e1/index.html'),
  'Build the collection first: npm run build:collection with BEARLETT_MINT.'
)

declare global {
  interface Window {
    hostCalls: Array<{type: string; operation?: string}>
    hostStore: Map<string, string>
    collectionMint: {url: string; issue(pubkey: string, card?: number): string}
    BearlettCollectionPreview: {
      TestNutftMint: new (options: {url: string}) => {
        issue(pubkey: string): string
      }
    }
    reloadNapplet(options?: {seed?: string}): void
    deliverNapplet(topic: string, payload: unknown): void
  }
}

const opened = async (page: Page) => {
  const errors: string[] = []
  const logged: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => logged.push(message.text()))
  await page.goto('/collection')
  const collection = page.frameLocator('#collection')
  await expect(
    collection.getByRole('heading', {name: 'No cards yet'})
  ).toBeVisible()
  return {collection, errors, logged}
}

const cardsHeld = (collection: ReturnType<Page['frameLocator']>) =>
  collection.locator('.counters dd').first()

const addressOf = async (collection: ReturnType<Page['frameLocator']>) => {
  await collection.getByRole('button', {name: 'Receive', exact: true}).click()
  const field = collection.getByLabel('Your address in this collection')
  await expect(field).toHaveValue(/^0[23][0-9a-f]{64}$/)
  return field.inputValue()
}

const mintOperations = (page: Page) =>
  page.evaluate(() =>
    window.hostCalls
      .filter(call => call.type === 'nutft.request')
      .map(call => call.operation)
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
  await expect(field).toHaveValue('')
  expect((await mintOperations(page)).length).toBe(before)

  const card = await page.evaluate(
    pubkey => window.collectionMint.issue(pubkey, 1),
    address
  )
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

test('a card from another napplet waits in the field for the holder', async ({
  page
}) => {
  const {collection, errors} = await opened(page)
  const address = await addressOf(collection)
  await collection.getByRole('button', {name: 'Close'}).click()
  const card = await page.evaluate(
    pubkey => window.collectionMint.issue(pubkey, 2),
    address
  )
  await page.evaluate(
    token => window.deliverNapplet('napplet:collection/receive', {token}),
    card
  )
  const field = collection.getByLabel('Card token')
  await expect(field).toHaveValue(card)
  await expect(field).toBeFocused()
  await expect(cardsHeld(collection)).toHaveText('0')

  /* A second card does not push out the one already waiting. */
  const next = await page.evaluate(
    pubkey => window.collectionMint.issue(pubkey, 3),
    address
  )
  await page.evaluate(
    token => window.deliverNapplet('napplet:collection/receive', {token}),
    next
  )
  await expect(
    collection.getByText('A card is already waiting here to be redeemed.', {
      exact: false
    })
  ).toBeVisible()
  await expect(field).toHaveValue(card)

  await collection.getByRole('button', {name: 'Redeem'}).click()
  await expect(collection.getByText('Received 1 card.')).toBeVisible()
  expect(errors).toEqual([])
})

test('opens nothing for a malformed seed, and seals the account wallet', async ({
  page
}) => {
  const {collection} = await opened(page)
  await page.evaluate(() => window.reloadNapplet({seed: 'AB'.repeat(32)}))
  await expect(
    collection.getByText(
      'This collection could not be opened safely. Close it and try again.'
    )
  ).toBeVisible()
  const keys = await page.evaluate(() => [...window.hostStore.keys()])
  expect(keys.filter(key => /:[0-9a-f]{16}$/.test(key))).toEqual([])

  const seed = '4b'.repeat(32)
  await page.evaluate(value => window.reloadNapplet({seed: value}), seed)
  await expect(
    collection.getByText(
      'Nothing to restore: this account holds no cards at this mint yet.'
    )
  ).toBeVisible({timeout: 60000})
  const stored = await page.evaluate(() => Object.fromEntries(window.hostStore))
  const account = Object.keys(stored).find(key =>
    /^bearlett:nutft:600b-e1:[0-9a-f]{16}$/.test(key)
  )!
  expect(JSON.parse(stored[account])).toMatchObject({v: 1, alg: 'A256GCM'})
  expect(stored[account]).not.toContain(seed)
})

test('moves the device cards to the account on one press', async ({page}) => {
  const {collection, errors} = await opened(page)
  const address = await addressOf(collection)
  const card = await page.evaluate(
    pubkey => window.collectionMint.issue(pubkey, 0),
    address
  )
  await collection.getByLabel('Card token').fill(card)
  await collection.getByRole('button', {name: 'Redeem'}).click()
  await expect(collection.getByText('Received 1 card.')).toBeVisible()

  await page.evaluate(() => window.reloadNapplet({seed: '5c'.repeat(32)}))
  await expect(
    collection.getByText('Move your cards to your account.')
  ).toBeVisible({timeout: 60000})
  await expect(cardsHeld(collection)).toHaveText('1')
  await collection.getByRole('button', {name: 'Move cards'}).click()
  await expect(
    collection.getByText('Moved 1 card to your account.')
  ).toBeVisible({timeout: 60000})
  await expect(cardsHeld(collection)).toHaveText('1')
  const random = await page.evaluate(() =>
    JSON.parse(window.hostStore.get('bearlett:nutft:600b-e1')!)
  )
  expect(random.tokens).toEqual([])
  expect(errors).toEqual([])
})

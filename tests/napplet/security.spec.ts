import {test, expect} from '@playwright/test'

test('payment confirmation stays bound to the invoice reviewed before a delayed storage read', async ({
  page
}) => {
  await page.addInitScript(() => {
    addEventListener('message', event => {
      if ((window as any).holdRead && event.data?.type === 'storage.get') {
        ;(window as any).holdRead = false
        ;(window as any).heldRead = {source: event.source, data: event.data}
        event.stopImmediatePropagation()
      }
    })
  })
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet', exact: true}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  await page
    .getByRole('button', {name: 'Receive demo note', exact: true})
    .click()
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet.getByRole('button', {name: 'Pay', exact: true}).click()
  await wallet.getByLabel('BOLT11 invoice', {exact: true}).fill('lnbc210n1qqqq')
  await wallet
    .getByLabel('Note to spend', {exact: true})
    .selectOption({label: '21 sats · demo.mint.test'})
  await page.evaluate(() => {
    ;(window as any).holdRead = true
  })
  await wallet
    .getByRole('button', {name: 'Confirm payment', exact: true})
    .click()
  await expect
    .poll(() => page.evaluate(() => !!(window as any).heldRead))
    .toBe(true)
  await wallet.getByLabel('BOLT11 invoice', {exact: true}).fill('lnbc210n1pppp')
  await page.evaluate(() => {
    const held = (window as any).heldRead
    held.source.postMessage(
      {
        id: held.data.id,
        type: held.data.type + '.result',
        ok: true,
        value: (window as any).hostStores.wallet.get(held.data.key) ?? null
      },
      '*'
    )
  })
  await expect(wallet.locator('.status.pending')).toHaveCount(1)
  const paid = await page.evaluate(() =>
    (window as any).hostCalls
      .filter(
        (call: any) => call.url && new URL(call.url).searchParams.has('pr')
      )
      .map((call: any) => new URL(call.url).searchParams.get('pr'))
  )
  expect(paid).toEqual(['lnbc210n1qqqq'])
})

test('synthetic activity cannot keep the wallet unlocked', async ({page}) => {
  await page.clock.install()
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet', exact: true}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  await page.clock.fastForward(4 * 60_000)
  const frame = page.frames().find(value => value.url() === 'about:srcdoc')!
  await frame.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown'))
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'a'}))
  })
  await page.clock.fastForward(61_000)
  await expect(
    wallet.getByRole('heading', {name: 'Welcome back.'})
  ).toBeVisible()
})

test('locks immediately while a mint request is pending', async ({page}) => {
  await page.addInitScript(() => {
    addEventListener('message', event => {
      if ((window as any).holdMint && event.data?.type === 'resource.bytes')
        event.stopImmediatePropagation()
    })
  })
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet', exact: true}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  await wallet.getByRole('button', {name: 'Mint', exact: true}).click()
  await wallet
    .getByLabel('Mint URL or Lightning address', {exact: true})
    .fill('https://demo.mint.test/pay')
  await wallet.getByLabel('Amount (sats)', {exact: true}).fill('21')
  await page.evaluate(() => {
    ;(window as any).holdMint = true
  })
  await wallet
    .getByRole('button', {name: 'Create funding invoice', exact: true})
    .click()
  await expect(wallet.getByRole('status')).toContainText('Working')
  await expect(
    wallet.getByRole('button', {name: 'Lock wallet', exact: true})
  ).toBeEnabled()
  await wallet.getByRole('button', {name: 'Lock wallet', exact: true}).click()
  await expect(
    wallet.getByRole('heading', {name: 'Welcome back.'})
  ).toBeVisible()
})

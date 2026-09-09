import {test, expect} from '@playwright/test'

test('Cashu notes share the collection and handover reserves value', async ({
  page
}, info) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  await page.getByRole('button', {name: 'Receive Cashu demo'}).click()
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await expect(wallet.getByLabel('LNURLcash or Cashu note')).toHaveValue(
    /^cashuB/
  )
  await expect(wallet.getByText('32 sats', {exact: true})).toBeVisible()
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await expect(
    wallet.locator('.badge').filter({hasText: /^CASHU$/})
  ).toHaveCount(1)
  await page
    .getByRole('button', {name: 'Receive demo note', exact: true})
    .click()
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(2)
  const frame = page.frames().find(frame => frame.url() === 'about:srcdoc')!
  expect(
    await frame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: `test-results/bearlett-${info.project.name}.png`,
    fullPage: true
  })
  await wallet
    .getByRole('checkbox', {name: 'Select 32 sats ready', exact: true})
    .check()
  await wallet.getByRole('button', {name: 'Hand over', exact: true}).click()
  await expect(wallet.getByLabel('Bearer note for handover')).toHaveValue(
    /^cashuB/
  )
  await wallet.getByRole('button', {name: 'Show history', exact: true}).click()
  await expect(wallet.locator('.status.shared')).toHaveCount(1)
  expect(errors).toEqual([])
})

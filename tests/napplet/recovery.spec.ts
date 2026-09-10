import {test, expect} from '@playwright/test'

test('avatar recovery opens wallet restore only after unlock and review; never rewrites the vault', async ({
  page
}) => {
  await page.goto('/wallet')
  const wallet = page.frameLocator('#wallet')
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test recovery wallet password')
  await wallet
    .getByLabel('Repeat password')
    .fill('test recovery wallet password')
  await wallet.getByLabel('I have saved my recovery phrase').check()
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  await wallet.getByRole('button', {name: 'Lock wallet'}).click()
  const before = await page.evaluate(() =>
    JSON.stringify([...(window as any).hostStores.wallet])
  )
  await page.evaluate(() =>
    (window as any).deliverNapplet('napplet:wallet/recovery-v1', {
      version: 1,
      guildId: '600b',
      memberId: 'founder-dni',
      caseId: 'case-123'
    })
  )
  await expect(wallet.getByRole('status')).toContainText(
    'Avatar recovery does not unlock'
  )
  await expect(wallet.getByRole('dialog')).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      JSON.stringify([...(window as any).hostStores.wallet])
    )
  ).toBe(before)
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test recovery wallet password')
  await wallet.getByRole('button', {name: 'Unlock wallet'}).click()
  await expect(
    wallet.getByRole('heading', {name: 'Restore your wallet separately'})
  ).toBeVisible()
  await wallet.getByRole('button', {name: 'Open backup and restore'}).click()
  await expect(
    wallet.getByRole('heading', {name: 'Import a napplet backup'})
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      JSON.stringify([...(window as any).hostStores.wallet])
    )
  ).toBe(before)
  expect(
    await page.evaluate(() =>
      (window as any).hostCalls.filter(
        (call: any) => call.type === 'resource.bytes'
      )
    )
  ).toHaveLength(0)
})

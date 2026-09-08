import {test, expect} from '@playwright/test'

test('encrypted wallet, explicit receive, banknote artwork and designer intent round-trip', async ({
  page
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const wallet = page.frameLocator('#wallet')
  await expect(
    wallet.getByRole('heading', {name: 'A home for your sats.'})
  ).toBeVisible()
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByLabel('Repeat password').fill('test wallet password')
  await wallet.getByRole('button', {name: 'Create wallet'}).click()
  await expect(wallet.getByRole('heading', {name: 'Your notes'})).toBeVisible()
  const frame = page
    .frames()
    .find(frame => frame.name() === 'wallet' || frame.url() === 'about:srcdoc')!
  expect(
    await frame.evaluate(() => {
      try {
        window.localStorage.getItem('test')
        return false
      } catch {
        return true
      }
    })
  ).toBe(true)
  await page.getByRole('button', {name: 'Receive demo note'}).click()
  await expect(wallet.getByRole('dialog')).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (window as any).hostCalls.filter(
          (c: any) => c.type === 'resource.bytes'
        ).length
    )
  ).toBe(0)
  await wallet.getByRole('button', {name: 'Review details'}).click()
  await expect(wallet.getByLabel('LNURLcash note')).toHaveValue(
    /https:\/\/demo\.mint\.test/
  )
  await wallet.getByRole('button', {name: 'Confirm receive & rotate'}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await expect(wallet.locator('.banknote')).toHaveCount(1)
  const raw = await page.evaluate(() =>
    [...(window as any).hostStores.wallet.values()].join('')
  )
  expect(raw).not.toContain('abababababababab')
  expect(raw).not.toContain('demo.mint.test')
  await wallet.getByRole('button', {name: 'Design notes'}).click()
  await wallet.getByRole('button', {name: 'Open Paper Studio'}).click()
  const designer = page.frameLocator('#designer')
  await expect(
    designer.getByRole('heading', {name: 'Make something worth holding.'})
  ).toBeVisible()
  await designer.getByLabel('Note heading').fill('TWENTY ONE CLUB')
  await designer.getByRole('button', {name: 'Copper palette'}).click()
  await designer.getByLabel('Upload artwork').setInputFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 320
        canvas.height = 320
        const c = canvas.getContext('2d')!
        c.fillStyle = '#dfbd78'
        c.fillRect(0, 0, 320, 320)
        c.fillStyle = '#fbefc2'
        c.beginPath()
        c.arc(213, 94, 51, 0, Math.PI * 2)
        c.fill()
        c.fillStyle = '#315c42'
        c.beginPath()
        c.moveTo(0, 300)
        c.lineTo(90, 115)
        c.lineTo(196, 300)
        c.fill()
        c.fillStyle = '#224436'
        c.beginPath()
        c.moveTo(110, 320)
        c.lineTo(225, 153)
        c.lineTo(320, 310)
        c.fill()
        return canvas.toDataURL('image/png').split(',')[1]
      }),
      'base64'
    )
  })
  await expect(designer.locator('.banknote-art')).toBeVisible()
  await page.screenshot({
    path: `test-results/designer-${testInfo.project.name}.png`,
    fullPage: true
  })
  await designer.getByRole('button', {name: 'Use in wallet'}).click()
  await page.getByRole('button', {name: 'Wallet', exact: true}).click()
  await expect(wallet.locator('.banknote-heading').first()).toHaveText(
    'TWENTY ONE CLUB'
  )
  await expect(wallet.locator('.banknote-art')).toHaveCount(1)
  expect(
    await frame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: `test-results/wallet-${testInfo.project.name}.png`,
    fullPage: true
  })
  await wallet.getByRole('button', {name: 'Lock wallet'}).click()
  await expect(
    wallet.getByRole('heading', {name: 'Welcome back.'})
  ).toBeVisible()
  await page.evaluate(() => (window as any).reloadWallet())
  await wallet
    .getByLabel('Wallet password', {exact: true})
    .fill('test wallet password')
  await wallet.getByRole('button', {name: 'Unlock wallet'}).click()
  await expect(wallet.locator('.banknote-heading').first()).toHaveText(
    'TWENTY ONE CLUB'
  )
  await wallet
    .getByRole('checkbox', {name: 'Select 21 sats ready', exact: true})
    .check()
  await wallet.getByLabel('Split amount (sats)', {exact: true}).fill('7')
  await wallet
    .getByRole('button', {name: 'Split selected', exact: true})
    .click()
  await expect(wallet.locator('.status.ready')).toHaveCount(2)
  await wallet
    .getByRole('checkbox', {name: 'Select 7 sats ready', exact: true})
    .check()
  await wallet
    .getByRole('checkbox', {name: 'Select 14 sats ready', exact: true})
    .check()
  await wallet.getByRole('button', {name: 'Combine', exact: true}).click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet.getByRole('button', {name: 'Pay', exact: true}).click()
  await wallet.getByLabel('BOLT11 invoice', {exact: true}).fill('lnbc210n1qqqq')
  await wallet
    .getByLabel('Note to spend', {exact: true})
    .selectOption({label: '21 sats · demo.mint.test'})
  await wallet
    .getByRole('button', {name: 'Confirm payment', exact: true})
    .click()
  await expect(wallet.locator('.status.pending')).toHaveCount(1)
  await expect(wallet.getByRole('status')).toContainText(
    'Settlement is not yet confirmed'
  )
  await wallet.getByRole('button', {name: 'Mint', exact: true}).click()
  await wallet
    .getByLabel('Mint URL or Lightning address', {exact: true})
    .fill('https://demo.mint.test/pay')
  await wallet.getByLabel('Amount (sats)', {exact: true}).fill('31')
  await wallet
    .getByRole('button', {name: 'Create funding invoice', exact: true})
    .click()
  await expect(wallet.getByLabel('Funding invoice', {exact: true})).toHaveValue(
    'lnbc310n1qqqq'
  )
  await wallet.getByRole('button', {name: 'Notes', exact: true}).click()
  await wallet
    .getByRole('checkbox', {name: 'Select 31 sats pending', exact: true})
    .check()
  await wallet
    .getByRole('button', {name: 'Check selected', exact: true})
    .click()
  await expect(wallet.locator('.status.ready')).toHaveCount(1)
  await wallet
    .getByRole('checkbox', {name: 'Select 31 sats ready', exact: true})
    .check()
  await wallet.getByRole('button', {name: 'Hand over', exact: true}).click()
  await expect(
    wallet.getByLabel('Bearer note for handover', {exact: true})
  ).toHaveValue(/https:\/\/demo\.mint\.test/)
  await expect(wallet.locator('.status.ready')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('refuses an ephemeral standalone wallet', async ({page}) => {
  await page.goto('/raw-wallet')
  await expect(page.getByRole('alert')).toContainText(
    'Open this wallet in a napplet shell'
  )
  await expect(page.getByRole('button', {name: 'Create wallet'})).toHaveCount(0)
})

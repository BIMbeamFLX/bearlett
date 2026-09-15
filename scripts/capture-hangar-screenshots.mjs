// Recaptures the Hangar prototype screenshots in docs/screenshots/.
//
// Usage, from the repository root:
//   node scripts/capture-hangar-screenshots.mjs [outDir]
//
// Opens docs/prototype/bearlett-hangar.html in Playwright's Chromium, clicks
// through the prototype's own controls and writes nine PNGs: eight 1440x1000
// desktop shots and one 390x844 mobile shot, all at device scale factor 1.
// Needs the Playwright Chromium build and network access for the Google Fonts
// the prototype loads. Body text uses the system-ui font, so captures made on
// another operating system differ in glyphs.
//
// Repeatable settings: fixed viewport, scale, locale and time zone; reduced
// motion; Date pinned to the original capture time (2026-09-10 00:05:29
// CEST); fonts, visible images and finite animations settled before each
// shot. The intent log shows real elapsed milliseconds, so only those digits
// differ between runs. The prototype binds its pointer tilt only when motion
// is allowed, so the tilt shot gets its own page without reduced motion.

import {chromium} from '@playwright/test'
import {pathToFileURL} from 'node:url'

const outDir = process.argv[2] ?? 'docs/screenshots'
const prototype = pathToFileURL('docs/prototype/bearlett-hangar.html').href
const browser = await chromium.launch()

async function openHangar(reducedMotion) {
  const context = await browser.newContext({
    viewport: {width: 1440, height: 1000},
    deviceScaleFactor: 1,
    reducedMotion,
    locale: 'en-GB',
    timezoneId: 'Europe/Vienna'
  })
  await context.clock.setFixedTime(new Date('2026-09-10T00:05:29.725+02:00'))
  const page = await context.newPage()
  await page.goto(prototype)
  await page.locator('#invState', {hasText: 'Holdings from vault'}).waitFor()
  return page
}

async function shot(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready
    const inView = img => {
      const box = img.getBoundingClientRect()
      return box.width > 0 && box.bottom > 0 && box.top < innerHeight
    }
    await Promise.all([...document.images].filter(inView).map(i => i.decode()))
    const finite = document
      .getAnimations()
      .filter(a => a.effect.getTiming().iterations !== Infinity)
    await Promise.all(finite.map(a => a.finished))
  })
  await page.screenshot({path: `${outDir}/${name}`, animations: 'disabled'})
  console.log(`wrote ${outDir}/${name}`)
}

const page = await openHangar('reduce')
const dock = dTag => page.locator(`.nap-btn[data-d="${dTag}"]`).click()
await shot(page, 'hangar-collection.png')

// The pointer rests on the card's centre, as in the earlier capture: the card
// lifts and its foil lights.
const tilt = await openHangar('no-preference')
await tilt.locator('.tile[data-id="E1-037"]').hover()
await shot(tilt, 'hangar-collection-tilt.png')

await page.locator('.tile[data-id="E1-262"]').click()
await shot(page, 'hangar-card.png')
await page.locator('#btnFlip').click()
await shot(page, 'hangar-card-back.png')

// With reduced motion the reveal opens at the end of its timeline.
await dock('bearlett-reveal')
await shot(page, 'hangar-reveal.png')

await dock('bearlett-overview')
await page.locator('#ovRecent .p-row').nth(2).waitFor()
await shot(page, 'hangar-pay-overview.png')

// Inserting the example offer focuses the amount field.
await dock('bearlett-pay')
await page.locator('#exOffer').click()
await page.keyboard.type('21')
await shot(page, 'hangar-pay-send-bolt12.png')

await dock('bearlett-trade')
await page.locator('#btnDemoKey').click()
await shot(page, 'hangar-trade.png')

await dock('bearlett-collection')
await page.setViewportSize({width: 390, height: 844})
await shot(page, 'hangar-mobile-collection.png')

await browser.close()

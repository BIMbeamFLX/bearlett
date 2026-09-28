// Note designs from the Hangar's Note Designer: the contract the Hangar
// checks (nappelin apps/hangar/src/vendor/bearlett/design.ts), and keeping
// one in the wallet.
import {describe, expect, it} from 'vitest'
import {
  offeredDesign,
  parseDesign,
  parseDesignMessage
} from '../../src/wallet/design.ts'
import {DESIGN_KEY, STATE_KEY, memoryStore} from '../../src/wallet/store.ts'
import {
  newMnemonic,
  openJson,
  sealJson,
  seedOf,
  stateKey
} from '../../src/wallet/vault.ts'
import {Wallet} from '../../src/wallet/wallet.ts'
import {fetchNet} from '../../src/platform/web.ts'

const design = {
  title: 'BEARLETT BEARER NOTE',
  subtitle: 'Whoever holds the note holds the sats.',
  ink: '#174c3a',
  paper: '#f3ecd3'
}
const image = 'data:image/png;base64,iVBORw0KGgo='

describe('a note design', () => {
  it('reads what the Note Designer sends', () => {
    expect(parseDesign(design)).toEqual(design)
    expect(parseDesign({...design, image})).toEqual({...design, image})
    expect(
      parseDesignMessage({kind: 'lnurlcash/note-design', version: 1, design})
    ).toEqual(design)
  })

  it('is taken from Note Designer only', () => {
    const message = {kind: 'lnurlcash/note-design', version: 1, design}
    expect(offeredDesign(message, 'note-designer')).toEqual(design)
    expect(offeredDesign(message, 'collection-600b-e1')).toBeNull()
    expect(offeredDesign(message, '')).toBeNull()
    expect(() =>
      offeredDesign({...message, version: 2}, 'note-designer')
    ).toThrow()
  })

  it('keeps nothing but appearance', () => {
    expect(parseDesign({...design, amount: 1000, k1: 'ab'})).toEqual(design)
  })

  it('refuses what the Hangar refuses', () => {
    for (const bad of [
      {...design, title: ' '},
      {...design, title: 'x'.repeat(49)},
      {...design, subtitle: 'x'.repeat(101)},
      {...design, ink: 'red'},
      {...design, paper: '#f3ecd'},
      {...design, image: 'https://evil.example/pixel.png'},
      {...design, image: 'data:image/svg+xml;base64,PHN2Zz4='},
      {...design, image: `data:image/png;base64,${'A'.repeat(180000)}`},
      null,
      [design]
    ])
      expect(() => parseDesign(bad)).toThrow()
    expect(() =>
      parseDesignMessage({kind: 'other', version: 1, design})
    ).toThrow()
    expect(() =>
      parseDesignMessage({kind: 'lnurlcash/note-design', version: 2, design})
    ).toThrow()
  })

  it('is kept in the wallet until it goes back to plain notes', async () => {
    const store = memoryStore()
    const words = newMnemonic()
    const wallet = await Wallet.create({net: fetchNet, store}, words, 'pw')
    await wallet.setDesign(parseDesign({...design, image}))
    const again = await Wallet.unlock({net: fetchNet, store}, 'pw')
    expect(again.design).toEqual({...design, image})
    await again.setDesign(null)
    expect(again.design).toBeUndefined()
    expect(await store.get(DESIGN_KEY)).toBeNull()
    await expect(
      again.setDesign({...design, ink: 'not a colour'})
    ).rejects.toThrow()
  })

  it('lives apart from the state, which every save rewrites', async () => {
    const store = memoryStore()
    const words = newMnemonic()
    const wallet = await Wallet.create({net: fetchNet, store}, words, '')
    await wallet.setDesign(parseDesign({...design, image}))
    const key = await stateKey(seedOf(words))
    const state = await openJson(key, (await store.get(STATE_KEY))!)
    expect(state.settings.design).toBeUndefined()
    expect(await openJson(key, (await store.get(DESIGN_KEY))!)).toEqual({
      ...design,
      image
    })
    // a save of the state leaves the design where it is
    const sealed = await store.get(DESIGN_KEY)
    await wallet.setGapLimit(30)
    expect(await store.get(DESIGN_KEY)).toBe(sealed)
  })

  it('opens even when the design cannot move yet, and moves it on a later opening', async () => {
    const inner = memoryStore()
    let failing = true
    const store = {
      ...inner,
      async set(key: string, value: string) {
        if (failing && key === DESIGN_KEY) throw new Error('quota exceeded')
        await inner.set(key, value)
      }
    }
    const words = newMnemonic()
    const created = await Wallet.create({net: fetchNet, store}, words, '')
    await created.setGapLimit(20)
    const key = await stateKey(seedOf(words))
    const state = await openJson(key, (await store.get(STATE_KEY))!)
    state.settings.design = {...design, image}
    await store.set(STATE_KEY, await sealJson(key, state))
    // the store refuses the design: the wallet opens, and shows it anyway
    const first = await Wallet.unlock({net: fetchNet, store}, '')
    expect(first.design).toEqual({...design, image})
    expect(await store.get(DESIGN_KEY)).toBeNull()
    // a design this version cannot read never keeps the wallet shut either
    const odd = await openJson(key, (await store.get(STATE_KEY))!)
    odd.settings.design = {...design, ink: 'no colour'}
    await store.set(STATE_KEY, await sealJson(key, odd))
    failing = false
    const unreadable = await Wallet.unlock({net: fetchNet, store}, '')
    expect(unreadable.design).toBeUndefined()
    // with a readable one back and the store working, it moves
    odd.settings.design = {...design, image}
    await store.set(STATE_KEY, await sealJson(key, odd))
    const moved = await Wallet.unlock({net: fetchNet, store}, '')
    expect(moved.design).toEqual({...design, image})
    expect(moved.snapshot.settings.design).toBeUndefined()
    expect(await store.get(DESIGN_KEY)).not.toBeNull()
  })

  it('moves a design the state held before to its own key', async () => {
    const store = memoryStore()
    const words = newMnemonic()
    const created = await Wallet.create({net: fetchNet, store}, words, '')
    await created.setGapLimit(20)
    const key = await stateKey(seedOf(words))
    const state = await openJson(key, (await store.get(STATE_KEY))!)
    state.settings.design = {...design, image}
    await store.set(STATE_KEY, await sealJson(key, state))
    const wallet = await Wallet.unlock({net: fetchNet, store}, '')
    expect(wallet.design).toEqual({...design, image})
    expect(wallet.snapshot.settings.design).toBeUndefined()
    const reopened = await Wallet.unlock({net: fetchNet, store}, '')
    expect(reopened.design).toEqual({...design, image})
  })
})

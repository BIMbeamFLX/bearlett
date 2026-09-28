// Note designs from the Hangar's Note Designer: the contract the Hangar
// checks (nappelin apps/hangar/src/vendor/bearlett/design.ts), and keeping
// one in the wallet.
import {describe, expect, it} from 'vitest'
import {parseDesign, parseDesignMessage} from '../../src/wallet/design.ts'
import {memoryStore} from '../../src/wallet/store.ts'
import {newMnemonic} from '../../src/wallet/vault.ts'
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
    expect(again.snapshot.settings.design).toEqual({...design, image})
    await again.setDesign(null)
    expect(again.snapshot.settings.design).toBeUndefined()
    await expect(
      again.setDesign({...design, ink: 'not a colour'})
    ).rejects.toThrow()
  })
})

import {describe, expect, it} from 'vitest'
import {
  EDITIONS,
  InvalidAccountWallets,
  InvalidMint,
  MintNotConfigured,
  UnknownEdition,
  checkMintAddress,
  isEditionMode,
  resolveEdition
} from './editions'
import {storageKeyFor} from './bootstrap'

describe('the edition registry', () => {
  it('keys every edition by its own id, so a build mode cannot lie', () => {
    for (const [key, edition] of Object.entries(EDITIONS))
      expect(edition.id).toBe(key)
  })

  it('uses ids a storage key and a build mode both accept', () => {
    for (const id of Object.keys(EDITIONS)) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/)
      expect(storageKeyFor({id})).toBe(`bearlett:nutft:${id}`)
    }
  })

  it('gives each edition its own storage key', () => {
    const keys = Object.keys(EDITIONS).map(id => storageKeyFor({id}))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('names collections that differ, since the unit is the collection id', () => {
    const ids = Object.values(EDITIONS).map(e => e.collectionId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('lists only https mirrors', () => {
    for (const edition of Object.values(EDITIONS)) {
      expect(edition.mirrors.length).toBeGreaterThan(0)
      for (const mirror of edition.mirrors) {
        expect(new URL(mirror).protocol).toBe('https:')
        /* An origin, not a path: the transport matches by origin. */
        expect(new URL(mirror).pathname).toBe('/')
      }
    }
  })
})

describe('resolveEdition', () => {
  it('binds an edition to the mint the build was given', () => {
    expect(resolveEdition('600b-g', 'https://tcg.example/g')).toEqual({
      id: '600b-g',
      mint: 'https://tcg.example/g',
      units: ['600B-G'],
      mirrors: EDITIONS['600b-g'].mirrors,
      accountWallets: false
    })
  })

  it('leaves account wallets out unless the build turns them on', () => {
    for (const value of [undefined, '', '0'])
      expect(
        resolveEdition('600b-e1', 'https://tcg.nappelin.com', value)
          .accountWallets
      ).toBe(false)
    expect(
      resolveEdition('600b-e1', 'https://tcg.nappelin.com', '1').accountWallets
    ).toBe(true)
  })

  it('stops the build on a flag value it does not know', () => {
    for (const value of ['true', 'yes', 'on', ' 1', '01', 'false'])
      expect(() =>
        resolveEdition('600b-e1', 'https://tcg.nappelin.com', value)
      ).toThrow(InvalidAccountWallets)
  })

  it('pins the unit to the collection id the mint signs with', () => {
    expect(resolveEdition('600b-e1', 'https://tcg.example').units).toEqual([
      '600B-E1'
    ])
  })

  it('refuses to build without a mint rather than guessing one', () => {
    expect(() => resolveEdition('600b-g', undefined)).toThrow(MintNotConfigured)
    expect(() => resolveEdition('600b-g', '')).toThrow(MintNotConfigured)
  })

  it('accepts the production mint exactly as written', () => {
    expect(resolveEdition('600b-e1', 'https://tcg.nappelin.com').mint).toBe(
      'https://tcg.nappelin.com'
    )
    expect(checkMintAddress('https://tcg.example/g')).toBe(
      'https://tcg.example/g'
    )
  })

  it('refuses a mint address instead of normalising it', () => {
    const refused: Array<[string, RegExp]> = [
      ['http://tcg.nappelin.com', /must use https/],
      ['http://127.0.0.1:4190', /must use https/],
      ['tcg.nappelin.com', /is not a URL/],
      [
        'https://tcg.nappelin.com/',
        /must not end with a slash: use https:\/\/tcg\.nappelin\.com\./
      ],
      [
        'https://tcg.example/g/',
        /must not end with a slash: use https:\/\/tcg\.example\/g\./
      ],
      ['https://user:pw@tcg.nappelin.com', /credentials/],
      ['https://tcg.nappelin.com?x=1', /query or a fragment/],
      ['https://tcg.nappelin.com#top', /query or a fragment/],
      ['https://tcg.nappelin.com?', /query or a fragment/],
      [
        'https://TCG.nappelin.com',
        /written as the mint writes it: https:\/\/tcg\.nappelin\.com\./
      ],
      ['https://tcg.nappelin.com:443', /written as the mint writes it/]
    ]
    for (const [mint, reason] of refused) {
      expect(() => resolveEdition('600b-e1', mint)).toThrow(InvalidMint)
      expect(() => resolveEdition('600b-e1', mint)).toThrow(reason)
    }
  })

  it('refuses an edition it does not know, and says which it does', () => {
    expect(() => resolveEdition('600b-e2', 'https://tcg.example')).toThrow(
      UnknownEdition
    )
    expect(() => resolveEdition('600b-e2', 'https://tcg.example')).toThrow(
      /600b-e1, 600b-g/
    )
  })

  it('does not resolve a prototype-chain name as an edition', () => {
    expect(isEditionMode('constructor')).toBe(false)
    expect(isEditionMode('toString')).toBe(false)
    expect(() => resolveEdition('constructor', 'https://x.example')).toThrow(
      UnknownEdition
    )
  })

  it('knows an edition mode from any other build mode', () => {
    expect(isEditionMode('600b-g')).toBe(true)
    expect(isEditionMode('notes')).toBe(false)
    expect(isEditionMode('production')).toBe(false)
  })
})

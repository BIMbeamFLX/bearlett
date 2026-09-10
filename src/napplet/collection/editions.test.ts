import {describe, expect, it} from 'vitest'
import {
  EDITIONS,
  MintNotConfigured,
  UnknownEdition,
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
      mirrors: EDITIONS['600b-g'].mirrors
    })
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

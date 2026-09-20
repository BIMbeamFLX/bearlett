import {describe, expect, it} from 'vitest'
import {isValidNpub} from './nostrAddress'

describe('isValidNpub', () => {
  // NIP-19's own example key
  const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg'
  it('accepts a well-formed npub, case-insensitively and trimmed', () => {
    expect(isValidNpub(NPUB)).toBe(true)
    expect(isValidNpub(`  ${NPUB.toUpperCase()}  `)).toBe(true)
  })
  it('rejects other bech32 strings, bad checksums and hex keys', () => {
    expect(isValidNpub('nsec1' + NPUB.slice(5))).toBe(false)
    expect(isValidNpub(NPUB.slice(0, -1) + 'x')).toBe(false)
    expect(
      isValidNpub(
        '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'
      )
    ).toBe(false)
    expect(isValidNpub('')).toBe(false)
  })
})

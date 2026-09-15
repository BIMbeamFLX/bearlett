import {describe, expect, it} from 'vitest'
import {createHash} from 'node:crypto'
import * as bip39 from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey} from '@scure/bip32'
import {getPubKeyFromPrivKey} from '@cashu/cashu-ts'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {UNSAFE_OPEN_MESSAGE} from '../../host/nutft-contract'
import {
  WALLET_KEY_PATH,
  hostMnemonic,
  seedFingerprint,
  seededWallet
} from './seed'

const SEED = 'a1'.repeat(32)
const crypto = {...bip39, wordlist, HDKey}

const refused = [
  '',
  SEED.slice(2),
  SEED + 'a1',
  SEED.toUpperCase(),
  'g'.repeat(64),
  ` ${SEED.slice(1)}`
]

describe('seedFingerprint', () => {
  it('is the first 16 hex of sha256 over the labelled seed', () => {
    const expected = createHash('sha256')
      .update(`bearlett:nutft:fingerprint:${SEED}`)
      .digest('hex')
      .slice(0, 16)
    expect(seedFingerprint(SEED)).toBe(expected)
    expect(seedFingerprint(SEED)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('tells two accounts apart', () => {
    expect(seedFingerprint(SEED)).not.toBe(seedFingerprint('b2'.repeat(32)))
  })

  it('refuses anything that is not a host seed, without naming it', () => {
    for (const value of refused) {
      expect(() => seedFingerprint(value)).toThrow(UNSAFE_OPEN_MESSAGE)
      try {
        seedFingerprint(value)
      } catch (error) {
        if (value) expect(String((error as Error).stack)).not.toContain(value)
      }
    }
  })
})

describe('hostMnemonic', () => {
  /* Derived here from the documented recipe, not from the module's own code. */
  const recipe = (seed: string, editionId: string) =>
    bip39.entropyToMnemonic(
      hkdf(
        sha256,
        hexToBytes(seed),
        utf8ToBytes('bearlett:nutft:wallet'),
        utf8ToBytes(editionId),
        32
      ),
      wordlist
    )

  it('encodes 32 bytes of edition entropy as 24 BIP39 words', () => {
    const words = hostMnemonic(SEED, '600b-e1', crypto)
    expect(words).toBe(recipe(SEED, '600b-e1'))
    expect(words.split(' ')).toHaveLength(24)
    expect(bip39.validateMnemonic(words, wordlist)).toBe(true)
  })

  it('gives each edition its own wallet from one account seed', () => {
    const e1 = hostMnemonic(SEED, '600b-e1', crypto)
    const g = hostMnemonic(SEED, '600b-g', crypto)
    expect(e1).not.toBe(g)
    expect(hostMnemonic(SEED, '600b-e1', crypto)).toBe(e1)
    /* And never the seed read directly as entropy. */
    expect(e1).not.toBe(bip39.entropyToMnemonic(hexToBytes(SEED), wordlist))
  })

  it('refuses a malformed seed before any words exist', () => {
    for (const value of refused)
      expect(() => hostMnemonic(value, '600b-e1', crypto)).toThrow(
        UNSAFE_OPEN_MESSAGE
      )
    expect(() => hostMnemonic(SEED, '', crypto)).toThrow(UNSAFE_OPEN_MESSAGE)
  })
})

describe('seededWallet', () => {
  it('derives the key on the card library path, with nothing held yet', () => {
    const words = hostMnemonic(SEED, '600b-e1', crypto)
    const key = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(words)).derive(
      "m/129373'/10'/0'/0'/0"
    ).privateKey!
    expect(WALLET_KEY_PATH).toBe("m/129373'/10'/0'/0'/0")
    expect(seededWallet(words, crypto, {getPubKeyFromPrivKey})).toEqual({
      privateKey: bytesToHex(key),
      pubkey: bytesToHex(getPubKeyFromPrivKey(key)),
      seedPhrase: words,
      counters: {},
      tokens: [],
      outgoing: [],
      pending: null
    })
  })
})

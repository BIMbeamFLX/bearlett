import {describe, expect, it} from 'vitest'
import {createHash} from 'node:crypto'
import * as bip39 from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey} from '@scure/bip32'
import {getPubKeyFromPrivKey} from '@cashu/cashu-ts'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
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
  it('encodes the 32 bytes as 24 BIP39 words, with no derivation of its own', () => {
    expect(hostMnemonic('00'.repeat(32), crypto)).toBe(
      `${'abandon '.repeat(23)}art`
    )
    const words = hostMnemonic(SEED, crypto)
    /* The host derives a seed per collection; the collection takes it as is. */
    expect(words).toBe(bip39.entropyToMnemonic(hexToBytes(SEED), wordlist))
    expect(words.split(' ')).toHaveLength(24)
    expect(bip39.validateMnemonic(words, wordlist)).toBe(true)
  })

  it('refuses a malformed seed before any words exist', () => {
    for (const value of refused)
      expect(() => hostMnemonic(value, crypto)).toThrow(UNSAFE_OPEN_MESSAGE)
  })
})

describe('seededWallet', () => {
  it('derives the key on the card library path, with nothing held yet', () => {
    const words = hostMnemonic(SEED, crypto)
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

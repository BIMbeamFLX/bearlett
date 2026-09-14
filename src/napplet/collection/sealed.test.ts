import {describe, expect, it} from 'vitest'
import {hkdf} from '@noble/hashes/hkdf.js'
import {sha256} from '@noble/hashes/sha2.js'
import {hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {UNSAFE_OPEN_MESSAGE} from '../../host/nutft-contract'
import {sealedWith, storageKeyMaterial} from './sealed'
import {WalletUnreadable} from './wallets'

const SEED = 'c4'.repeat(32)
const KEY = 'bearlett:nutft:600b-e1:0123456789abcdef'
const STATE = JSON.stringify({
  privateKey: '9f'.repeat(32),
  pubkey: '03' + '8e'.repeat(32),
  seedPhrase: 'legal winner thank year wave sausage worth useful legal winner',
  tokens: ['cashuBo2FteBdodHRwczovL21pbnQudGVzdC9lMQ']
})

const openWith = async (seed: string, stored: string, key = KEY) =>
  sealedWith(seed)
    .open(stored, key)
    .then(
      value => value,
      (error: Error) => error
    )

describe('sealedWith', () => {
  it('opens what it sealed, and stores none of it in the clear', async () => {
    const codec = sealedWith(SEED)
    const stored = await codec.seal(STATE, KEY)
    expect(await codec.open(stored, KEY)).toBe(STATE)
    for (const part of ['9f9f9f', '8e8e8e', 'legal winner', 'cashuB', SEED])
      expect(stored).not.toContain(part)
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual([
      'alg',
      'data',
      'iv',
      'v'
    ])
  })

  it('seals the same state differently every time', async () => {
    const codec = sealedWith(SEED)
    expect(await codec.seal(STATE, KEY)).not.toBe(await codec.seal(STATE, KEY))
  })

  it('does not open under another storage key', async () => {
    const stored = await sealedWith(SEED).seal(STATE, KEY)
    const outcome = await openWith(SEED, stored, `${KEY}0`)
    expect(outcome).toBeInstanceOf(WalletUnreadable)
  })

  it('does not open for another account', async () => {
    const stored = await sealedWith(SEED).seal(STATE, KEY)
    expect(await openWith('d5'.repeat(32), stored)).toBeInstanceOf(
      WalletUnreadable
    )
  })

  it('refuses a tampered or unsealed value without repeating it', async () => {
    const stored = JSON.parse(await sealedWith(SEED).seal(STATE, KEY))
    const flipped = `${stored.data.slice(0, -2)}${stored.data.endsWith('00') ? '01' : '00'}`
    for (const value of [
      JSON.stringify({...stored, data: flipped}),
      JSON.stringify({...stored, iv: '00'.repeat(12)}),
      STATE,
      'not json at all'
    ]) {
      const outcome = await openWith(SEED, value)
      expect(outcome).toBeInstanceOf(WalletUnreadable)
      expect((outcome as Error).message).not.toMatch(/legal|cashu|9f9f/)
    }
  })

  it('derives its key with a label, never from the seed bytes alone', () => {
    expect(storageKeyMaterial(SEED)).toEqual(
      hkdf(
        sha256,
        hexToBytes(SEED),
        utf8ToBytes('bearlett:nutft:storage'),
        utf8ToBytes('account wallet, AES-256-GCM, v1'),
        32
      )
    )
    expect(storageKeyMaterial(SEED)).not.toEqual(hexToBytes(SEED))
  })

  it('refuses to derive from anything but a host seed', () => {
    for (const seed of ['', SEED.toUpperCase(), SEED.slice(2)])
      expect(() => sealedWith(seed)).toThrow(UNSAFE_OPEN_MESSAGE)
  })
})

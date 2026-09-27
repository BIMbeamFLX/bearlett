// Secrets at rest. The seed phrase is sealed with a passphrase (PBKDF2 +
// AES-GCM); everything else the wallet stores is sealed with a key derived
// from the seed itself, so changing the passphrase never re-encrypts state.
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic
} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {base64} from '@scure/base'

export const normalizeMnemonic = (words: string): string =>
  words.trim().toLowerCase().split(/\s+/).join(' ')

export const newMnemonic = (): string => generateMnemonic(wordlist, 128)

export const isMnemonic = (words: string): boolean =>
  validateMnemonic(normalizeMnemonic(words), wordlist)

/** BIP-39 seed, no BIP-39 passphrase: the words alone restore the wallet. */
export const seedOf = (words: string): Uint8Array =>
  mnemonicToSeedSync(normalizeMnemonic(words))

export type SealedVault = {
  v: 1
  iterations: number
  salt: string
  iv: string
  data: string
}

const ITERATIONS = 600_000
const encoder = new TextEncoder()

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer

const passphraseKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    'raw',
    buffer(encoder.encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations},
    material,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  )
}

export const sealMnemonic = async (
  words: string,
  passphrase: string
): Promise<SealedVault> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await passphraseKey(passphrase, salt, ITERATIONS)
  const data = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: buffer(iv)},
    key,
    buffer(encoder.encode(normalizeMnemonic(words)))
  )
  return {
    v: 1,
    iterations: ITERATIONS,
    salt: base64.encode(salt),
    iv: base64.encode(iv),
    data: base64.encode(new Uint8Array(data))
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase.')
    this.name = 'WrongPassphraseError'
  }
}

export const openMnemonic = async (
  vault: SealedVault,
  passphrase: string
): Promise<string> => {
  const key = await passphraseKey(
    passphrase,
    base64.decode(vault.salt),
    vault.iterations
  )
  try {
    const plain = await crypto.subtle.decrypt(
      {name: 'AES-GCM', iv: buffer(base64.decode(vault.iv))},
      key,
      buffer(base64.decode(vault.data))
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new WrongPassphraseError()
  }
}

export const isSealedVault = (value: unknown): value is SealedVault => {
  const v = value as SealedVault
  return (
    typeof v === 'object' &&
    v !== null &&
    v.v === 1 &&
    Number.isSafeInteger(v.iterations) &&
    typeof v.salt === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.data === 'string'
  )
}

// ---- the wallet state, sealed with a key derived from the seed ----

export const stateKey = async (seed: Uint8Array): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    'raw',
    buffer(seed),
    'HKDF',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new ArrayBuffer(0),
      info: buffer(encoder.encode('bearlett/state/v1'))
    },
    material,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  )
}

export const sealJson = async (
  key: CryptoKey,
  value: unknown
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv: buffer(iv)},
    key,
    buffer(encoder.encode(JSON.stringify(value)))
  )
  return `${base64.encode(iv)}.${base64.encode(new Uint8Array(data))}`
}

export const openJson = async (
  key: CryptoKey,
  sealed: string
): Promise<unknown> => {
  const [iv, data] = sealed.split('.')
  const plain = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: buffer(base64.decode(iv))},
    key,
    buffer(base64.decode(data))
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

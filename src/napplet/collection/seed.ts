import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {UnsafeLease, isHostSeed} from '../../host/nutft-contract'

/**
 * The account's seed, once the shell has handed it over.
 *
 * The shell sends 32 bytes and never words; `readNutftLease` has already
 * refused anything else. This module turns those bytes into the three things
 * the collection needs: the mnemonic the card library derives its key and
 * NUT-13 counters from, a fingerprint that names the wallet's storage key
 * without revealing the seed, and the wallet state the library itself writes
 * for that mnemonic.
 *
 * None of these values is logged or put into an error. A seed that is not a
 * host seed throws the one fixed sentence the lease uses, whatever it was.
 */

/** The path the card library derives its P2BK key on. */
export const WALLET_KEY_PATH = "m/129373'/10'/0'/0'/0"

/** The parts of `{...bip39, wordlist, HDKey}` used here. */
export type SeedCrypto = {
  entropyToMnemonic(entropy: Uint8Array, wordlist: string[]): string
  mnemonicToSeedSync(mnemonic: string): Uint8Array
  wordlist: string[]
  HDKey: {
    fromMasterSeed(seed: Uint8Array): {
      derive(path: string): {privateKey: Uint8Array | null}
    }
  }
}

/** The part of cashu-ts used here. */
export type KeyTools = {
  getPubKeyFromPrivKey(privateKey: Uint8Array): Uint8Array
}

/** A wallet state exactly as the card library's `restoreSeed` begins it. */
export type SeededWallet = {
  privateKey: string
  pubkey: string
  seedPhrase: string
  counters: Record<string, number>
  tokens: string[]
  outgoing: Array<{token: string}>
  pending: null
}

const checked = (seed: string): string => {
  if (!isHostSeed(seed)) throw new UnsafeLease()
  return seed
}

/**
 * First 16 hex characters of sha256("bearlett:nutft:fingerprint:" + seed).
 *
 * It names a storage key, so it may be seen; 64 bits are plenty to keep two
 * accounts on one device apart, and far too few to say anything about the seed.
 */
export const seedFingerprint = (seed: string): string =>
  bytesToHex(
    sha256(utf8ToBytes(`bearlett:nutft:fingerprint:${checked(seed)}`))
  ).slice(0, 16)

/**
 * The 24 words the 32 bytes encode. Kept in memory, never shown.
 *
 * The seed is this collection's own already: the host derives it per lease
 * scope, so two collections of one account never share a seed, and it is used
 * as the wallet's entropy directly. A second derivation here would only be a
 * second recipe for the host and the collection to keep in step.
 */
export const hostMnemonic = (
  seed: string,
  crypto: Pick<SeedCrypto, 'entropyToMnemonic' | 'wordlist'>
): string =>
  crypto.entropyToMnemonic(hexToBytes(checked(seed)), crypto.wordlist)

/**
 * The state the library's `restoreSeed` writes for this mnemonic before it
 * finds a card: the same key path, the same hex, the same empty counters. The
 * collection writes it first, so the account's wallet has its own key from the
 * moment it exists and the library never has a chance to generate a random one
 * under the account's storage key.
 */
export function seededWallet(
  mnemonic: string,
  crypto: Pick<SeedCrypto, 'mnemonicToSeedSync' | 'HDKey'>,
  keys: KeyTools
): SeededWallet {
  const privateKey = crypto.HDKey.fromMasterSeed(
    crypto.mnemonicToSeedSync(mnemonic)
  ).derive(WALLET_KEY_PATH).privateKey
  if (!privateKey) throw new UnsafeLease()
  return {
    privateKey: bytesToHex(privateKey),
    pubkey: bytesToHex(keys.getPubKeyFromPrivKey(privateKey)),
    seedPhrase: mnemonic,
    counters: {},
    tokens: [],
    outgoing: [],
    pending: null
  }
}

// LUD-25 "The canonical spend transaction" and "What a signature signs":
// every note is spent as input 0 of one fixed, never-broadcast transaction,
// so a spend's signature is an ordinary BIP-341 signature hash over it.
import {
  concatBytes,
  sha256,
  taggedHash,
  u32le,
  u64le,
  utf8ToBytes
} from './bytes.ts'
import {compactSize} from './taproot.ts'

/** A spend's claimed nLockTime and nSequence (Timelocks). */
export type TimeClaim = {locktime: number; sequence: number}

/** A key path always claims locktime 0 and sequence 0xffffffff. */
export const KEY_PATH_CLAIM: TimeClaim = {locktime: 0, sequence: 0xffffffff}

/**
 * The domain a spend is bound to: SERVICE's full domain name, lowercased,
 * the string LUD-05 hashes. Taken from a note or callback URL's host,
 * without port.
 */
export const spendDomain = (url: string): string =>
  new URL(url).hostname.toLowerCase()

/** prevout txid of input 0: binds the mint. */
export const mintOutpointTxid = (domain: string): Uint8Array =>
  taggedHash('LNURLcash/mint', utf8ToBytes(domain.toLowerCase()))

const OP_1 = 0x51

/** The spent output's scriptPubKey, OP_1 <Q>: binds the note. */
export const noteScriptPubkey = (q: Uint8Array): Uint8Array =>
  concatBytes(Uint8Array.of(OP_1, 0x20), q)

/**
 * BIP-341 SigMsg for input 0 with SIGHASH_DEFAULT, plus BIP-342's
 * extension (tapleaf hash, key version 0, no OP_CODESEPARATOR) when
 * `leafHash` is given.
 */
export const spendSigMsg = (
  q: Uint8Array,
  domain: string,
  claim: TimeClaim,
  leafHash?: Uint8Array
): Uint8Array => {
  const scriptPubkey = noteScriptPubkey(q)
  return concatBytes(
    Uint8Array.of(0x00), // hash_type: SIGHASH_DEFAULT
    u32le(2), // nVersion
    u32le(claim.locktime),
    sha256(concatBytes(mintOutpointTxid(domain), u32le(0))), // sha_prevouts
    sha256(u64le(0n)), // sha_amounts: the spent amount is always 0
    sha256(concatBytes(compactSize(scriptPubkey.length), scriptPubkey)),
    sha256(u32le(claim.sequence)), // sha_sequences
    sha256(concatBytes(u64le(0n), Uint8Array.of(0x00))), // sha_outputs
    Uint8Array.of(leafHash ? 0x02 : 0x00), // spend_type
    u32le(0), // input_index
    ...(leafHash ? [leafHash, Uint8Array.of(0x00), u32le(0xffffffff)] : [])
  )
}

/** tagged_hash("TapSighash", 0x00 || SigMsg): what a spend's signature signs. */
export const spendSighash = (
  q: Uint8Array,
  domain: string,
  claim: TimeClaim,
  leafHash?: Uint8Array
): Uint8Array =>
  taggedHash(
    'TapSighash',
    concatBytes(Uint8Array.of(0x00), spendSigMsg(q, domain, claim, leafHash))
  )

/**
 * The canonical spend transaction itself, serialized with its witness. A
 * wallet never needs it to sign; it exists so a spend can be handed to any
 * taproot verifier (and to compare against test vector 3).
 */
export const canonicalSpendTx = (
  domain: string,
  claim: TimeClaim,
  witness: Uint8Array[]
): Uint8Array =>
  concatBytes(
    u32le(2),
    Uint8Array.of(0x00, 0x01), // segwit marker and flag
    Uint8Array.of(1), // one input
    mintOutpointTxid(domain),
    u32le(0),
    Uint8Array.of(0), // empty scriptSig
    u32le(claim.sequence),
    Uint8Array.of(1), // one output
    u64le(0n),
    Uint8Array.of(0), // empty scriptPubKey
    compactSize(witness.length),
    ...witness.flatMap(item => [compactSize(item.length), item]),
    u32le(claim.locktime)
  )

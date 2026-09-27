// LUD-25 "Offline verification": SERVICE certifies a note as a cs1, a
// recoverable ECDSA signature made the way LUD-13 signs, over
//   message = "LNURLcash:" || amount_msat || ":" || hex(Q)
//   digest  = sha256(sha256("Lightning Signed Message:" || message))
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, bytesToNumberBE, sha256, utf8ToBytes} from './bytes.ts'
import {decodeCs1, encodeCs1} from './encoding.ts'

export const certificateMessage = (amountMsat: number, q: Uint8Array): string =>
  `LNURLcash:${amountMsat}:${bytesToHex(q)}`

export const certificateDigest = (
  amountMsat: number,
  q: Uint8Array
): Uint8Array =>
  sha256(
    sha256(
      utf8ToBytes(
        `Lightning Signed Message:${certificateMessage(amountMsat, q)}`
      )
    )
  )

/** The amount a cs1 certifies for Q and the key that signed it, or null. */
export const openCertificate = (
  cs1: string,
  q: Uint8Array
): {amountMsat: number; signer: string} | null => {
  const certificate = decodeCs1(cs1)
  if (!certificate) return null
  const {amountMsat, signature} = certificate
  const recovery = signature[64]
  if (recovery > 3) return null
  try {
    const sig = new secp256k1.Signature(
      bytesToNumberBE(signature.slice(0, 32)),
      bytesToNumberBE(signature.slice(32, 64)),
      recovery
    )
    const signer = sig
      .recoverPublicKey(certificateDigest(amountMsat, q))
      .toBytes(true)
    return {amountMsat, signer: bytesToHex(signer)}
  } catch {
    return null
  }
}

/** The certified amount when `cs1` is `mintPubkey`'s certificate for Q. */
export const verifyCertificate = (
  cs1: string,
  q: Uint8Array,
  mintPubkey: string
): number | null => {
  const opened = openCertificate(cs1, q)
  return opened && opened.signer === mintPubkey.toLowerCase()
    ? opened.amountMsat
    : null
}

/** SERVICE's side, deterministic (RFC 6979): for mock mints and vectors. */
export const signCertificate = (
  amountMsat: number,
  q: Uint8Array,
  mintSecretKey: Uint8Array
): string => {
  const recovered = secp256k1.sign(
    certificateDigest(amountMsat, q),
    mintSecretKey,
    {
      prehash: false,
      format: 'recovered'
    }
  )
  // noble puts the recovery id first; LUD-25 puts it last
  const signature = new Uint8Array(65)
  signature.set(recovered.slice(1), 0)
  signature[64] = recovered[0]
  return encodeCs1(amountMsat, signature)
}

// Two throwaway FIPS node identities for one mesh run, as JSON on stdout.
import {schnorr} from '@noble/curves/secp256k1.js'
import {bech32} from '@scure/base'
import {bytesToHex} from '@noble/hashes/utils.js'

const node = () => {
  const secret = schnorr.utils.randomSecretKey()
  const npub = bech32.encode(
    'npub',
    bech32.toWords(schnorr.getPublicKey(secret)),
    1000
  )
  return {nsec: bytesToHex(secret), npub}
}
console.log(JSON.stringify({a: node(), b: node()}))

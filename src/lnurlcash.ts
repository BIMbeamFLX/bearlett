import {bytesToHex} from '@noble/hashes/utils.js'
import {
  configureNetworkGuard,
  configurePubkeySecretProvider,
  configureSecretProvider,
  configureTransport
} from '@lnurlcash/kit'
import type {MintFee} from '@lnurlcash/kit'
import {fetchServiceResponse, isServiceOffline} from './serviceTransport'
import {offlineMode} from './offlineMode'
import {nextCashSecret, requireRecoverableCashSecret} from './cashSecrets'
import {msatToSats} from './helpers'

// LUD-25 LNURLcash - bearer assets. Draft spec:
// https://github.com/lnurl/luds/blob/lnurlcash/25.md
//
// The protocol implementation is @lnurlcash/kit, published from dni's
// lnurl-wallet (src/lib there) so the reference wallet and this one share
// one implementation and one test suite. Everything protocol-shaped is
// re-exported from the kit unchanged: LNURL and note parsing, BOLT-11
// checks, Part 1 hash-keyed notes, Part 2 cp1/ck1/cs1/cx1 codecs and
// Schnorr ownership proofs, offline certificates, mint fees, LN address
// registration and recovery scans, and internal transfers.
//
// What stays here is this wallet's own policy rather than protocol:
// the offline toggle and the napplet host transport, seed-derived
// recoverable secrets, and display strings for mint fees. Every existing
// import of this module keeps working.
export * from '@lnurlcash/kit'

// Every request the kit makes passes this guard first. Web builds honour
// the wallet's offline toggle; napplet builds additionally honour the
// host's own offline preference (see serviceTransport.ts).
configureNetworkGuard(() => {
  if (offlineMode() || isServiceOffline()) {
    throw new Error(
      'Offline mode is on - turn it off in the nav to reach a service.'
    )
  }
})

// Napplet builds must fetch through the shell's NAP-RESOURCE grant; web
// builds use plain fetch. Redirects come back unfollowed either way so the
// kit can admit each destination before a bearer secret travels to it.
configureTransport(fetchServiceResponse)

// LUD-25 Part 1: for a rotate/split/merge, WALLET - not SERVICE - generates
// the replacement note's secret and discloses only its hash. Prefers a
// deterministic secret derived from this wallet's seed (see cashSecrets.ts)
// so a lost wallet can rebuild it from the seed phrase plus a small
// per-domain index, falling back to plain randomness only when no
// seed-derived root is loaded.
export const generateNoteSecret = (domain: string): string =>
  nextCashSecret(domain) ??
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)))

configureSecretProvider(generateNoteSecret)

// New mint invoices and cross-mint transfers must survive a reload after
// payment, so they cannot use the in-memory random fallback: require a
// seed-derived secret whose counter was persisted before the quote leaves
// this wallet.
export const generateMintSecret = (domain: string): string =>
  requireRecoverableCashSecret(domain)

// LUD-25 Part 2 issuance (cp1-committed notes signed with a note key) needs
// a seed branch this wallet does not derive yet - the kit ships the
// derivation (deriveDomainBranchNode, deriveNoteSecretKey), the wallet-side
// storage of note keys is still to come. Returning null tells the kit to
// keep issuing Part 1 hash-keyed outputs; Part 2 notes received from others
// are still decoded and verified through the kit's own codecs.
configurePubkeySecretProvider(() => null)

// fee_percent_ppm is parts-per-million - /10_000 for a percent, then trim
// the trailing zeros toFixed leaves behind (2000 ppm -> "0.2000" -> "0.2")
export const formatFeePercent = (ppm: number): string =>
  (ppm / 10_000).toFixed(4).replace(/\.?0+$/, '')

// parseMintFee already collapses a fully-zero fee down to null, so by the
// time one reaches here at least one of the two components is set - only
// mention the one(s) that actually are
export const describeMintFee = (fee: MintFee): string =>
  [
    fee.baseFeeMsat > 0 ? `${msatToSats(fee.baseFeeMsat)} sat flat` : null,
    fee.feePpm > 0
      ? `${formatFeePercent(fee.feePpm)}% of the amount paid`
      : null
  ]
    .filter(Boolean)
    .join(' + ')

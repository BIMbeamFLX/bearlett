import {bytesToHex} from '@noble/hashes/utils.js'
import {
  configureNetworkGuard,
  configurePubkeySecretProvider,
  configureSecretProvider,
  configureTransport,
  cp1FromCk1,
  hashK1,
  requestInvoice
} from '@lnurlcash/kit'
import type {InvoiceResult, MintFee} from '@lnurlcash/kit'
import {fetchServiceResponse, isServiceOffline} from './serviceTransport'
import {offlineMode} from './offlineMode'
import {
  nextCashAddressSecret,
  nextCashSecret,
  requireRecoverableCashAddressSecret,
  requireRecoverableCashSecret
} from './cashSecrets'
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

// LUD-25 Part 2: a note that already is pubkey-bound stays that way across
// a rotate/split/merge (the kit asks this provider whenever an input is a
// ck1), instead of coming back as a fresh Part 1 preimage. Null whenever no
// cash root is loaded, which tells the kit to fall back to the Part 1
// provider above.
configurePubkeySecretProvider(domain => {
  try {
    return nextCashAddressSecret(domain)
  } catch {
    return null
  }
})

// Part 2 counterpart to generateMintSecret: a wallet-initiated mint or
// transfer's own pubkey-bound output, seed-recoverable for the same
// reload-survival reason (see requireRecoverableCashAddressSecret).
export const generateMintPubkeySecret = (domain: string): string =>
  requireRecoverableCashAddressSecret(domain)

// Requests a mint invoice, preferring a Part 2 pubkey-bound output
// (comment=cp1<pk>) over the Part 1 hash-keyed one whenever the mint accepts
// it. There is no capability flag to check first (the draft dispatches by
// value shape, never by version), so this just tries. Requesting an invoice
// has no burn side effect: if the mint rejects a cp1 comment, no invoice was
// issued and nothing was paid, so falling back is always safe - at most one
// already-persisted address index goes unused. Callers already required
// commentAllowed >= 64 (requireMintComment); a cp1 value is 61 characters.
export const requestMintInvoice = async (
  callback: string,
  amountMsat: number,
  domain: string
): Promise<{result: InvoiceResult; secret: string}> => {
  try {
    const secret = generateMintPubkeySecret(domain)
    const cp1 = cp1FromCk1(secret)
    if (cp1) {
      const result = await requestInvoice(callback, amountMsat, cp1)
      return {result, secret}
    }
  } catch {
    // no cash root loaded, or the mint did not accept a cp1 comment - no
    // invoice exists either way, so the Part 1 path below is safe
  }
  const secret = generateMintSecret(domain)
  const result = await requestInvoice(callback, amountMsat, hashK1(secret))
  return {result, secret}
}

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

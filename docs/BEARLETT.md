# Implementation and recovery

`Bearlett` dispatches a shared public `Note` model to LNURLcash or `CashuEngine`.
A Cashu note bundles proofs of one canonical HTTPS mint and the `sat` unit.
Mint identity includes its path. Cards never contain spendable proofs.

## Ownership and persistence

Seed material, monotonic counters, assets and Cashu operations live in one
AES-GCM encrypted `cashu-v1` snapshot. Host writes must be acknowledged durably.
One BIP39 phrase supplies separate Cashu/NUT-13 and LNURLcash/LUD-25 derivations.
Old wallets enable Cashu only after proving their original phrase matches.

Before mutation, the journal records inputs, exact prepared outputs, blinding
material, quote, keyset and any NUT-20 quote key. Inputs become pending before
dispatch. Completion records replacement ownership in the same snapshot.
Shared assets remain stored but are excluded from available balances.

NUT-07 and NUT-09 are mandatory; melts also require NUT-08. cashu-ts validates
keysets, signatures, derivations and NUT-02 fees. Modern quote accounting cannot
move backwards. Missing legacy fields are filled only from the corresponding
request/journal. BOLT11 amount, checksum, expiry, signature and payment hash are
checked before Cashu payment confirmation.

## Interrupted operations

- Lost swap/mint replies use NUT-09 with saved outputs; recovered proofs undergo
  spent-state checks. If outputs do not exist yet, a swap can reuse its exact
  request after input checks; a funded mint can reuse its prepared issuance.
  No new counter range is allocated. Identical requests are compatible with
  NUT-19 caching; recovery does not depend on the cache or its lifetime.
- Submitted melts are never automatically replayed. Bound quote/preimage status
  determines settlement, and saved NUT-08 outputs reconstruct change. Ambiguous
  `UNPAID`/`PENDING` results retain the reservation. A mint that never returns a
  conclusive result may require operator assistance.
- Seed recovery scans keysets in ranges of 100, stops at an empty range, and
  advances counters before replacement. Reserved-but-unused counter gaps cannot
  be recovered from a phrase alone: keep full backups. A restored seed must
  scan each mint before generating new outputs there.
- Full backups restore into an empty wallet with the same phrase. Ready assets
  become unverified. A durable import marker blocks actions/background settlement
  after a torn import; the same file resumes idempotently. Original LNURLcash
  backup imports remain supported.

## Transfers and design

`transfers-v1` binds independently durable source and target records. The target
invoice is stored before preparing source notes. Review includes estimated
destination value, source preparation fees and maximum debit. Preparation can
itself incur split/swap fees.

Confirmation records `funding` before dispatch. Resume checks the source and
claims destination assets. Success requires stored destination issuance. If
LUD-21 omits a preimage, source consumption plus issuance against the exact target
invoice is required. An invalid supplied preimage is rejected.

Interrupted preparation may leave an orphan funding quote or prepared note;
inspect the operation/collection views before preparing another transfer. Paid
target quotes remain claimable. A timeout never causes another payment.

Wallet/Notes have distinct manifest identities/storage. The design payload keeps
`lnurlcash/note-design` for compatibility and includes appearance only. Wallet
supplies actual amounts and handover codes. Payment intents open review.

The host must enforce one writer per storage scope even without Cashu. The
Cashu extension provides `acquire()` for this. Preserve scopes across upgrades
or restore into a fresh scope. Tests establish interoperability with the tested
mints, not every implementation. Independent review remains a release gate.

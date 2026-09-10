# Bearlett: feasibility and spec check

Check date: 9 September 2026. Starting point: `87fd4f0` on
`feature/bearlett`. STARTPROMPT.md and the project documents named in it
were read in full. The existing changes to README.md and
package.json, and STARTPROMPT.md, remain. No wallet reimplementation,
no push, no publication, no change to Actions or third-party
Docker projects. Test coins and synthetic test keys only.

## Verdict

**The product is technically feasible; the present state is a usable
experimental base, but not yet a wallet that can be trusted with real funds.**
Both protocols and the Lightning bridge work in the reproduced regtest. Five
additional reproductions, however, show gaps at the storage/recovery boundary.
These must be fixed before new platforms are built. In particular, a fulfilled
`storage.setItem()` in the current Kehto/shim pair does not reliably mean that
the write succeeded.

Recommendation: a shared TypeScript transaction core, explicit storage,
transport, signer and lifecycle adapters; Web/PWA first, Android through a
limited Capacitor/Kotlin spike. For spec-aligned napplets the key-holding
wallet service belongs in the trusted host. Notes remains an independent
designer. Details and acceptance criteria are in
[ARCHITECTURE-2026-09-09.md](ARCHITECTURE-2026-09-09.md).

**Confirmed product decision:** One actively writing device with an explicit
device change is enough for V1. A dedicated CAS relay is therefore not a V1
prerequisite. The decision was first recorded in the local SQLite audit file.

Direction additionally requested during the check: XMR/USDT swaps through
mints with Granola. That is captured in the architecture as a separate, still
unproven extension. Granola's present Testnut SAT/USD swaps are neither native
XMR/USDT swaps nor a finished integration in dni's LNURLwallet.

## Feature/platform matrix

"Proven" applies only to the stated test boundary. "Experimental" means an
existing implementation with open integration or security questions;
"missing" means no corresponding Bearlett implementation.

| Function                                              | Napplets today                                                                                            | Web/PWA today                                                          | Android today                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Graphical LNURLcash/Cashu collection                  | Proven in preview, experimental on a real host                                                            | Original webwallet LNURLcash only; shared Bearlett UI missing          | App missing                                   |
| Separate Notes app, image upload, design handover     | Proven: two builds, separate tabs, review, no protocol secrets in the contract                            | Code reusable; dedicated Bearlett web flow missing                     | Feasible, not yet integrated                  |
| LNURLcash receive, rotation, split, merge, handover   | Unit/browser evidence; mint/transfer in regtest. RESOURCE mutations are a semantic host extension         | Original present and build green; hardware not checked on real devices | Core reusable; adapters missing               |
| Cashu A/B, unbound sats, receive with rotation        | Crypto fixtures and browser proven, real mint/melt operations in regtest                                  | Engine present, web integration missing                                | Engine reusable; app missing                  |
| Lightning mint/melt and protocol switch               | Both directions proven in regtest; error paths experimental                                               | No corresponding Bearlett web version yet                              | Missing                                       |
| Local encrypted backups                               | Present, but F00–F04 block release                                                                        | Legacy backup present; shared backup missing                           | Secure storage and restore missing            |
| Phrase recovery                                       | Present, incomplete counter search F04; mint list needed separately                                       | LNURLcash present; Cashu not integrated                                | Missing                                       |
| Wallet Nostr key, relay backup                        | Missing; IDENTITY/RELAY alone are not enough                                                              | NIP-07/NIP-46 technically available, integration missing               | NIP-55 technically available, integration missing |
| Device change                                         | Missing; a local host lease is not a device lock                                                          | Missing                                                                | Missing                                       |
| Camera                                                | No general camera NAP in the checked contract                                                             | Original scanner present; real camera unchecked                        | Native camera possible, device test missing   |
| NFC                                                   | Not usable as Web NFC under `allow-scripts`                                                               | Original present; Web NFC is browser/device dependent                  | Native NFC wiring possible, unchecked         |
| USB/BLE device vault                                  | Adapters and simulated tests present                                                                      | Original functions present                                             | Port and real device check missing            |
| HTLC/P2PK, USD, exchange/atomic swaps                 | Not V1                                                                                                    | Not V1                                                                 | Not V1                                        |

## Reproduced checks

Run with Node **24.15.0**, npm **11.12.1**, Git **2.53.0.windows.1**.
package.json names npm 12.0.2; that is not a version actually used here.
Existing Bearlett node_modules were used; no fresh `npm ci` for the
main checkout. Third-party projects were installed separately from their
lockfiles.

| Check                                               | Result this session                                                                                         | Local raw log                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm test`                                          | 353 passed, 1 opt-in integration test skipped                                                               | `unit.log`                                             |
| `npm run tsc`                                       | Passed                                                                                                      | `tsc.log`                                              |
| Original webwallet, Wallet, Notes build             | All passed; final HTMLs 418,712 / 34,631 bytes for Wallet/Notes                                             | `build-web.log`, `build-wallet.log`, `build-notes.log` |
| `npm run test:napplet:browser`                      | 12 passed; Windows preview process had to be killed after the tests ended, total run 8.3 minutes            | `browser.log`                                          |
| `npm run format:check`                              | Failed: 139 files                                                                                           | `format.log`                                           |
| Prettier with `--end-of-line auto`                  | Only STARTPROMPT.md remains; mostly CRLF/LF, no blanket reformat done                                       | `format-auto-eol.log`                                  |
| `npm audit --json`                                  | 0 reported vulnerabilities; not a security proof                                                            | `npm-audit.json`                                       |
| Real bidirectional regtest                          | 1 test passed, 5.58 s; lost melt reply, restore, change, only one melt                                      | `regtest.log`                                          |
| Additional isolated fault reproductions             | 5 observed misbehaviours confirmed; **no** green security acceptance tests                                  | `reproductions.log`                                    |
| Patched Kehto: affected packages + Paja Devtools    | 1103 tests passed in 65 files                                                                               | `kehto-tests.log`                                      |
| Entire patched Kehto                                | 1757 passed, 9 test failures; 9 failed files including 4 load failures                                      | `kehto-full-tests.log`                                 |
| Cashu Sync: `src/sync` and `src/v0`                 | 222 tests passed in 19 files                                                                                | `cashu-sync-tests.log`                                 |
| Cashu Sync: Go relay                                | All four test packages passed; two command packages without tests                                           | `cashu-sync-relay-tests.log`                           |
| Granola                                             | 442 passed, 7 skipped, 52 files                                                                             | `granola-tests.log`                                    |
| Envelope                                            | 36 local tests passed                                                                                       | `envelope-tests.log`                                   |
| Napplets Workshop                                   | Typecheck/build passed; conformance: 8 passed, 1 warning failure, 2 skipped, CLI judges "CONFORMANT"        | `workshop-verify.log`, `workshop-conformance.log`      |

Raw logs, source snapshots and SQLite live under
`outputs/feasibility-2026-09-09/` and are not versioned, per .gitignore.
The [evidence index](checks/evidence-2026-09-09.json) contains SHA-256 checksums
of the local artifacts and an export of the decisions previously recorded in
SQLite. The reproductions under [checks/](checks/) are versionable and runnable
without Docker or network. They deliberately assert the observed misbehaviour;
after a fix they must become tests of the desired invariants.

The regtest uses real Bitcoin/LND/mint implementations, but an
in-memory wallet store and a direct Node transport with two fixed
mapped HTTPS test identities. It proves neither durable browser storage
nor TLS, Android, signer or the production Kehto permission flow.

The Kehto overall failures include CRLF/path-sensitive assertions,
package/lockfile alignment, three script loaders and the unbuilt Paja CLI
export. The original statement "entire Kehto not green" remains correct.

## Prioritised findings

### F00 — P1: False success acknowledgement on host storage errors

Kehto's `packages/shell/src/hooks-adapter.ts:220` catches storage errors and
returns false on `set`; failed reads can appear as null/empty list.
`packages/runtime/src/state-handler.ts:208` answers the write with
`{ok: success}`. The installed shim 0.28.0 rejects only replies with
`error` and ignores `ok:false`.

The fifth reproduction test runs the **actually installed official
prelude code** in an isolated VM: `setItem()` fulfils on a
correlated `storage.set.result` reply with `ok:false`. The wallet can therefore
continue after an unsaved journal. The local vault's tests use a storage adapter
that correctly throws errors, and therefore do not discover this integration
fault.

Fix: the host must transport failed reads/writes as errors; the shim
must reject negative ACKs. Then test QuotaExceeded/I/O errors from real
storage through to a forbidden mint mutation. A read-back alone would not be
a transaction or power-loss guarantee.

### F01 — P1: Missing change can complete a melt

In `src/napplet/cashu/engine.ts:493` `resume()` processes a PAID quote and
inserts `quote.change ?? []`. `finish()` then marks inputs spent and the
operation complete. The reproduction pays 10 of 32 testsats; the fixture issues
21 sats of change; the quote reply omits `change`. Result: complete,
no available balance, no NUT-09 fallback. The payment preimage is correct.

Fix: bind quote ID, invoice, unit, amount and fees to the journal;
enforce minimum change `reservedAmount - maximumDebit`; restore existing
blank outputs and check their state. If required change is missing,
the payment stays in reconciliation. The immediately successful
`pay()` path needs the same value balance, not only the resume path.

### F02 — P1: Backup authenticates individual records, not completeness

`src/napplet/vault.ts:247` exports an unsealed container of encrypted
records; `restore()` checks only the records actually present. Removing
`metadata['cashu-v1']` from a valid backup is accepted and, in the reproduction,
yields an apparently successful import with no Cashu balance.
Mixing older valid records is therefore also not fundamentally detected.

Fix: authenticate the entire backup with version, wallet ID, revision, a complete
record directory, counters and journal references; do not interpret an
omission as "legacy". Import real legacy formats in an explicit separate
path. A valid signature of an old complete snapshot still does not prove
freshness.

### F03 — P1: Seed assignment incomplete on full import

`src/napplet/vault.ts:410` compares Cashu seeds only when the target wallet
already has `cashu-v1`. A new LNURLcash wallet with a **different** phrase and
Cashu still disabled therefore imports a foreign Cashu backup. Its current
phrase and the Cashu seed stored afterwards do not match; the foreign
LNURLcash root lands separately in `cash-imports`.

Fix: a full restore must prove the identity of all protocol roots before the
first write, or restore the entire wallet explicitly. "Import assets
from a foreign wallet" needs a separate migration flow, not a
silent phrase claim.

### F04 — P1: Seed recovery stops too early and re-enables the mint

`src/napplet/cashu/engine.ts:687` ends the search after **one** empty
range of 100 and sets the mint to scanned. Current NUT-13 recommends three
consecutive empty ranges. A simulated aborted reservation 0–99,
followed by actually signed outputs from 100, remains completely undetected; the
new counter stays null even though the mint is re-enabled for outputs.

Fix: at least the current NUT-13 search, stored high-water marks and
explicit extended search. Arbitrarily large reserved, never-signed gaps are
not provable from the phrase even with three batches. A full backup remains
necessary; if the old writer instance is unsafe/compromised, migrate funds under
a new seed.

### Further integration and specification gaps

| Priority | Finding / evidence                                                                                                                                                                                | Consequence                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | `src/host/cashu-service.ts:78`: writer owner only in a map per service; without Cashu, `acquire()` is missing. `CashuEngine.exclusive` and `Transfers.exclusive` protect only the respective instance. | No global wallet lock between shell tabs, processes, devices or all LNURLcash/backup actions.                                        |
| P1       | `Vault.backup()` reads several items; LNURLcash records and `transfers-v1` are not atomic with `cashu-v1`. UI `busy` does not protect all future API/adapter calls.                               | Backup and all mutations must use the same writer/transaction frame.                                                                     |
| P1       | Phrase, Cashu seed, proofs and local AES processing live in the napplet (`Vault`, `CashuEngine`).                                                                                                 | "Secrets never leave the signer" is false for this code. The host sandbox does not replace secure wallet custody.                        |
| P2       | Transfers persist links only after creating individual target/source operations. `resume` handles only funding/claiming.                                                                          | Abort in preparing/quoted can leave an orphan quote/reservation. No second payment, but no reconcile/cancel flow.                        |
| P2       | The current NAP-STORAGE draft isolates by `(dTag, aggregateHash)`. Kehto's default quota is 512 KiB. Ciphertext, journals and artwork grow.                                                       | Upgrade migration, capacity warnings and atomic storage outside the artifact scope are missing. Do not simply turn off scope isolation.  |
| P2       | The existing regtest helper waits for LND sync, but does not produce a fresh block when an old chain is already present. Bitcoin data lives in an anonymous image volume.                         | Restart needs a fresh block; rebuild must name the Bitcoin volume explicitly. Do not replace the existing volume.                        |
| P2       | FORMAT fails under the current Windows checkout; a historical green check is not transferable.                                                                                                    | Correct EOL behaviour separately and in small steps; do not reformat existing changes.                                                   |
| P2       | Current dni upstream is `b391530` (note tags); local starting point is older.                                                                                                                     | Catch up feature parity against the new state; no silent merge in this check.                                                            |

## Current specifications against implementation

Exact source snapshots and status evidence are in
[SOURCES-2026-09-09.md](SOURCES-2026-09-09.md). "Present in the repository",
"PR merged", "draft" and "SDK implemented" are different statements.

- **Manifest/NIP-5D:** The open NIP-5D PR 2303 defines napplet kinds
  5129/15129/35129 and takes the tag schema from NIP-5A. NIP-5A itself
  describes nsites with 15128/35128. The NAP registry still names 35128
  for napplets. Bearlett's build produces 35129: matching the current NIP-5D PR
  and SDK, not a proof of an adopted NIP-5D. The filename
  `.nip5a-manifest.json` comes from the plugin.
- **Sandbox:** `allow-scripts`, no `allow-same-origin`, namespace before app
  code, source binding and CSP are proven in preview. NIP-07 must not be
  injected directly into the napplet. Spec-aligned wallet custody requires the
  host.
- **SHELL:** mandatory handshake; both apps wait for `shell.ready()`.
  Discovery shows capabilities, but does not replace grant, durable storage
  or trusted scope assignment.
- **INTENT/INC:** registered APIs, NAP-INTENT/SHELL in registry Active;
  `wallet`, `bearer-designer` and all four `wallet/*` contracts remain local
  conventions. `ok/handled` is delivery, not a payment/import confirmation.
  Cold-start needs subscription-aware delivery; `shell.ready` alone can be too
  early. Check target and sender binding in real Paja.
- **Design:** `noteDesignMessage` and `parseDesign` allow presentation only.
  No amount, proof, k1, invoice or spendable QR in the contract. Free text and
  uploaded images can of course contain arbitrary content from the user;
  the app must never automatically render secrets into them.
- **STORAGE:** scoped KV, no CAS/multi-record transactions or
  device coordination. The draft requires reload persistence, not a universal
  wallet durability guarantee. F00 is additionally a concrete implementation
  fault.
- **IDENTITY/Signer:** `getPublicKey` is read-only and does not prove control.
  Paja implements `none/dev/nip07/nip46`, no NIP-55 wiring. A
  wallet-owned key is not created by IDENTITY or NIP-07.
- **RELAY/OUTBOX:** `publishEncrypted` and routing are present; no
  general napplet decrypt API (`identity.decrypt` was removed). ACKs and
  outbox routing are neither a backup custody contract nor a distributed lock.
- **RESOURCE:** byte resolution, not a free POST transport. The Cashu
  capability remains required and experimental. LNURLcash mutations via GET
  also lie semantically outside a purely reading resource capability. The
  nonce avoids URL caches; it does not grant payment authorisation.
- **LUD-25:** still draft on branch `lnurlcash`; LUD-03/06/12/16/17/21
  supply the building blocks. Persist rotate/split/merge replacements first;
  a vanished k1 is not a payment proof. Without a preimage the
  bridge needs proven source consumption and issuance to the exactly bound
  target.
- **Cashu:** NUT-00 A/V3 is still read, is deprecated; B/V4 recommended.
  NUT-01/02: keyset/unit/fees, NUT-03: swap; 04/05/23: quotes/BOLT11.
  Fee PPK is summed over inputs and rounded up; show routing reserve and
  mint fees separately. 07/09 are required here, 08 for melts.
  NUT-09 needs the exact outputs including blinding material, 13 the
  version-dependent derivation for 00 and 01 keysets and monotonic counters.
  19 is an optional request cache with TTL, not permission to blindly
  repay. 20 protects quote redemption and has a separate counter;
  the existing derivation path matches current NUT-20.
- **Quote recovery:** observe invoice/quote expiry before a new payment; do not
  destroy locally a quote that is already paid but expired. Leave unknown
  payments reserved. Modern `amount_paid/amount_issued/updated_at` are
  partly checked; full binding and balance across all paths is missing.
- **BOLT11:** checks for amount, checksum, expiry, signature and payment hash
  present. No proof of the complete official BOLT11/Cashu vectors;
  the crypto test-invoice generator is itself part of this codebase. Before
  release add independent valid/invalid vectors.

## Breno's projects: usable findings

### Cashu Sync

Revision `b5bcb00`, wallet SDK actually 4.7.0. Confirmed in the code: snapshot
v0 fixed to `usd`, one authority mint, event 30078 with its own d-tag, NIP-44
to own pubkey; event signature, schema and inner/outer predecessor are checked.
Go 1.26, Khatru 0.19.1, SQLite 1.56.0. `store.Advance` checks `prev` against the
current head and writes both inside a SQLite transaction; one
connection/one process serialises v0. NIP-42 auth, author binding and limits
live in the relay policy. The coordinator stores prepared requests and
requires relay consent before submit; unclear results stay for reconciliation.

This is more than "backups on ordinary relays", but not universal
fencing at the mint. Already authorised requests cannot be recalled after a
device change through a relay head. The strong assumption is
a cooperating client group with an available coordination service.
No Bearlett parity for token import/export, LNURLcash or multi-mint.
The 222 wallet tests and all four Go test packages were reproduced locally;
pairing on two real phones and live deployment were not.

License: `wallet/LICENSE.md` contains MIT/Cashu 2023. For the standalone relay
and remaining root files no corresponding license file was found. Do not take
their code into Bearlett. Good reference for state machine,
conflict handling and tests; not a reason to extend V1 with a CAS service.

### Granola

Revision `e25a4ec`, Cashu SDK 4.7.1. `src/cashu/htlc.ts`, trade coordinator,
proof reservations and Nostr transport confirm NUT-14/P2PK-based
HTLC swaps with a shared hash, refund times, persisted requests and
private Nostr coordination. Web Locks protect locally, no global device lock.
This is a different operation from LNURLcash↔Cashu over BOLT11. 442 tests
passed, seven skipped; no own live testnet swap was performed.

No LICENSE file and no license statement in package.json found. No
code uptake. Architecture/fault matrix useful as a reading reference;
functionally outside V1.

### Envelope

Revision `7d7ff1c`, installed Paja 0.11.0. Pointer resolver uses Kehto to
check signature, manifest, hashes and blobs. The adapted host starts
verified targets; intent contracts come from the manifest. The opener
transports start state by intent. Limits are timeout, missing contract
and missing first-online caching; an offline cache does not make a mint
reachable. 36 local tests passed; public live E2E deliberately not run.

`package.json` and the root lock entry declare MIT; no standalone LICENSE
found. That is a positive license declaration, but clarify copyright/license
text before uptake. Adapter idea usable. Do not copy Bearlett secrets into
Envelope fragments/browser history; encoding is not encryption.

### Napplets Workshop

Revision `45459f6`, SDK ^0.12.0, shim ^0.13.0, plugin ^0.8.1: a distinctly
older reference. Small breakout/SDK manifest example, MIT LICENSE present.
Typecheck/build pass. Conformance CLI reports overall CONFORMANT despite a
warning failure: `theme`, `storage`, `identity` were emitted without
declaration; lifecycle not measured. No wallet/signer/recovery proof.
Suitable as a small learning reference with license notices retained, not as
a current production contract.

## Evidence still missing

A real integrated Kehto/Paja host with Cashu grant, durable storage,
upgrade migration and signer; complete fault matrix, independent vectors,
relay round-trip/restore, wallet-key lifecycle, device handover, real Android
lifecycle/keystore/camera/NFC check. The concrete inventory, start/stop and
the runnable check commands are in
[INFRASTRUCTURE-2026-09-09.md](INFRASTRUCTURE-2026-09-09.md).

# Bearlett: corrections and handover for external audit

State: 9 September 2026, final local check run. Base:
`87fd4f01156a2c3f701eb473386cca727257d0c2`; working branch:
`fix/bearlett-security-boundaries`. This is a checked test state, not a
release for real funds. No publication and no merge.

This report updates the status from [FEASIBILITY](FEASIBILITY-2026-09-09.md)
and [INFRASTRUCTURE](INFRASTRUCTURE-2026-09-09.md). Their original findings,
test counts and reproductions remain as historical evidence.
Nappelin is the platform, Bearlett the wallet. Granola stays outside V1.

## What was changed and proven

| Area                     | Correction                                                                                                                                                                                                                     | Evidence / bound                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment consent          | Confirmed note and invoice are captured before the first asynchronous storage access. An intent populates the UI; a payment needs wallet confirmation.                                                                         | Browser regression case changes the invoice during a delayed read; only the confirmed invoice is paid.                                          |
| Unlock                   | Own wallet password remains required. Lock works during an in-flight request; old unlock/create/reset replies do not open a new session. Untrusted DOM inputs do not extend the timeout.                                       | Unit and browser tests; no claimed isolation against a compromised parent host.                                                                 |
| F00: storage errors      | Own storage adapter requires explicit `ok: true`, matching request ID, reply type and parent origin; errors and timeout abort.                                                                                                 | Negative write ACK reproduced and caught. The installed SDK itself was not changed.                                                             |
| F01: change              | Paid Cashu quotes are bound to the journal. Missing change is reconstructed with the already stored blank outputs via NUT-09. Bounds, assignment and UNSPENT status are checked.                                              | Missing, incomplete, foreign, duplicate and spent change; exactly one melt on lost reply.                                                       |
| F02: backup completeness | Backup v2 additionally authenticates the entire encrypted holdings including names and wrapped key. Removed records are detected before the first import write.                                                                | Tamper tests; v1 only with an explicitly chosen legacy import. No freshness guarantee against replay of a complete old backup.                  |
| F03: wrong seed          | A Cashu backup must match the LNURLcash derivation of the source and target wallet, even if Cashu is still disabled on the target.                                                                                             | Foreign-seed test requires rejection with no write access.                                                                                      |
| F04: recovery gaps       | Scan accounts for known reservations, uses 300 empty counters by default and allows a start counter and limited continuation. A scan never releases the old seed for writing.                                                  | Funds behind an empty range of 100 and explicit later search tested. A finite gap is not a completeness proof.                                  |
| Bearer handover          | Received LNURLcash secrets are rotated. Restore/seed recovery stays in quarantine; export to a fresh wallet reserves the copy as shared. Reconstructed Cashu change also remains unverified after restore.                     | Unit tests and real mint regtest: new wallet receives value, old copies are spent after rotation.                                               |
| Local overlap            | Cashu mutations, LNURLcash pay/transform/share and backup/restore use the shared lock of the same storage-adapter object. Snapshot revision detects additional local writes.                                                   | Concurrent engines and backup during mutation rejected. No cross-tab/cross-device lock, no database transaction.                                |

## Final results

| Check                                                                 | Result                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Bearlett unit suite                                                   | **389 passed, 1 skipped**, no failed tests                                                                             |
| TypeScript                                                            | passed                                                                                                                 |
| Original web build, Wallet napplet, Notes napplet                     | all three passed                                                                                                       |
| Playwright / Chromium                                                 | **18 passed**, 9 each for desktop and mobile viewport, no retries/flakes                                               |
| Bitcoin/LND/Nutshell/LNURLmint regtest                                | **1 complete integration case passed**                                                                                 |
| Nappelin Hangar, identity, locker, login lifecycle                    | **31 passed**                                                                                                          |
| TCG wallet sync                                                       | **6 passed**; mock relay/Blossom, no real backup service                                                               |
| Format check of all changed source/test files and diff whitespace     | passed                                                                                                                 |
| Repository-wide `npm run format:check`                                | still not green; existing format/line-ending problems outside this fix, log `outputs/security-format-all.txt`          |

The skipped legacy test `src/integration.test.ts` needs `MINT_K1` and a
separate mint on port 8137. That prerequisite was not set artificially.
The separate regtest uses real local services and test funds only.
Mobile viewport means Chromium with a small screen size, not an Android device.
Build warnings about Vite configuration, deprecated inlineDynamicImports and the
large original web bundle remain.

The historical negative test `docs/checks/feasibility.test.ts` was also
re-run: **4 deliberately obsolete fault assertions now fail**
(F01–F04). F00 still passes there, because it tests the unchanged installed SDK
directly. That is not a green acceptance suite. The corresponding positive
regression checks now live under `src/napplet/`.

The Nappelin and TCG tests ran against the existing working copies; their
HEADs were `1b2f2c8ca84e779aa51c31ce2d274341aca50c68` and
`d7535057480d3a16fcb6878eba78d70c66951fc5` respectively.
Not to be read as unmodified checkouts or a complete integrated
Bearlett-in-Nappelin proof.

## Highest-priority open work for the audit

1. **Device change is not yet a finished flow.** After backup restore the
   old seed is treated permanently as a recovery source. In the regtest,
   target note and change are rotated into a fresh wallet; the old
   transfer journal stays `claiming`. A resumable migration flow
   with linking and completion of both journals is missing. Do not unlock
   the old seed with a scanned switch.
2. **Host integration and storage contract.** Bearlett now requires explicit
   `ok: true` on `storage.get`, `storage.set` and `storage.keys`.
   Older hosts without this field are rejected. The preview host satisfies
   this. A real Kehto/Paja/Nappelin host with durable store and Cashu
   capability must be adapted and tested separately. An ACK alone still does
   not prove an fsync or atomic disk commit.
3. **Writer and crash bounds.** The local WeakMap lock protects only the same
   adapter object. It does not replace an exclusive host lease and does not
   cover every LNURLcash method or the entire cross-protocol transfer.
   Multi-tab, process kill at every journal step and incomplete pure
   LNURLcash/legacy import need additional tests and a durable
   storage adapter. The restore marker so far covers Cashu
   full imports in particular.
4. **Keys and isolation.** Platform key and wallet password are
   separate, but a malicious parent host can affect a web sandbox.
   Wallet Nostr key, its derivation/custody, recovery UX and protection against
   compromised Nappelin logins are not yet a continuously implemented
   system proof. The wallet processes its secrets in its own JS process.
5. **Blossom/Nostr and Android are missing as real integration proofs.**
   Bearlett does not yet have a finished remote-backup client. No isolated
   Blossom/Nostr round-trip was run for this state; TCG sync tests
   use mocks. Android app, keystore, signer, NFC, camera and real
   lifecycle/device tests remain open. The regtest does not need these services.
6. **Further check breadth.** Expand external protocol vectors, further mint
   implementations, the complete abort matrix in both transfer directions and
   adversarial mint/host replies. Tests do not replace a cryptographic review.

## Reproduce and inspect locally

From the repository root, with existing npm dependencies:

```sh
npm test
npm run tsc
npm run build
npm run build:napplet
npm run build:notes
```

The local preview is available at `http://127.0.0.1:4190/wallet` while
the preview process is running. It uses in-memory storage and mock mints;
reload loses the session. It is not bound to the real regtest mints.
To start again in terminal A:

```powershell
$env:PORT='4190'
node scripts/napplet-host.mjs
```

In terminal B, with an already running own preview host:

```powershell
$env:BEARLETT_EXTERNAL_HOST='1'
$env:PLAYWRIGHT_JSON_OUTPUT_FILE='outputs/security-browser-results.json'
node node_modules/@playwright/test/cli.js test --config playwright.napplet.config.ts --reporter=list,json
```

Without an external host remove the variable and use `npm run test:napplet:browser`.
Regtest start, fresh block on an old chain, ports and volume
preservation are in [INFRASTRUCTURE](INFRASTRUCTURE-2026-09-09.md).
Then `npm run test:regtest`. Stop only this stack:

```sh
docker compose -f tests/integration/compose.yaml stop
```

The existing five regtest services were reused. No third-party
Docker projects changed, no volumes deleted, nothing bought or publicly
deployed. The missing source path for a fresh LNURLmint image build
remains listed in the infrastructure report.

Machine-readable results and logs from this check stay local and are
gitignored. No wallet backups or spendable tokens are checked in.
The handover contains local checks; the independent external audit is outstanding.

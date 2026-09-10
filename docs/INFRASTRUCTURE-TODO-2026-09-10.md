# Infrastructure: what still has to be built

As of 10 September 2026. Addendum to
[INFRASTRUCTURE-2026-09-09.md](INFRASTRUCTURE-2026-09-09.md) (inventory and
test plan) and [UI-DESIGN-2026-09-09.md](UI-DESIGN-2026-09-09.md) (twelve composable
napplets). This document lists only what is missing, and orders it. None of it is
built or ordered.

## Principle: use existing mints

Bearlett does not run its own mint for sats. Three classes of issuer, all
present or operated by third parties:

| Asset             | Issuer                                                                                                                                                                                     | Present                                        | To do                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cashu sats        | Existing Nutshell mints. Regtest: `cashubtc/nutshell:0.20.3` on LND Bob, host port 43338. Production: choose public mints against criteria                                                  | Regtest yes, production mint selection no      | Apply the criteria list: NUT-07, NUT-08, NUT-09, NUT-13, NUT-20, fee policy, reachability, BOLT12 signal; at least two mints per unit for failover            |
| LNURLcash notes   | Existing LNURLmint instances (dni's `lnurl-mint`). Regtest: image `bearlett-regtest-lnurl:latest`, source `bd21f61`, on LND Alice, host port 48111                                         | Regtest yes, production service not identified | Identify public LNURLcash services and check them against LUD-25; no in-house operation in V1                                                                      |
| NutFT cards       | First-party mint of the TCG wallet (`TCG600nap/server/nutft-mint.js`). Per [TCG-WALLET-2026-09-09.md](TCG-WALLET-2026-09-09.md) it is required and not replaceable by third-party mints     | Code yes, operation see section F              | Hosting, Lightning backend, catalogue and artwork; instructions in [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md)                                             |

All a mint needs to serve Bearlett is an HTTPS endpoint with
the named NUTs and correct CORS headers. Both regtest mints answer
OPTIONS requests with `Access-Control-Allow-Origin: *`. That proves the preflight,
not the full browser flow.

## What is present

From the inventory of 9 September, unchanged:

- Regtest stack under WSL Ubuntu with Docker Engine 29.3.0: Bitcoin, LND Alice and
  Bob `v0.19.3-beta` with a funded channel, Nutshell, LNURLmint;
  `tests/integration/compose.yaml`, `scripts/regtest.mjs`, `npm run test:regtest`.
  Idle about 341 MiB RAM, images about 2.2 GB together.
- Real Kehto as a patched checkout of `kehto/web` (`14a14155` on
  `a7e0d12`); package tests passed.
- Blossom mirrors for card images: `blossom.primal.net`, `blossom.bimcvp.com`,
  `nostr.download`. Encrypted TCG backups currently run through
  `blossom.bimcvp.com` and `wss://relay.bimcvp.com` (kind 37378).
- Development host `scripts/napplet-host.mjs` with an in-memory test mint; not a
  production host.

`work/lnurl-mint` is gitignored. Restore that checkout or reuse an existing
LNURLmint image before every fresh regtest, as described in
INFRASTRUCTURE-2026-09-09.

## What has to be built

Order by dependency. Without A no napplet runs outside the preview.

### A. Shell and host capabilities

1. Production shell with the NAP domains `storage`, `resource`, `inc`, `intent`.
   Candidates: Kehto (checkout present) or the Nappelin Hangar (today it runs
   only a storage relay, see
   [NAPPELIN-INTEGRATION-2026-09-09.md](NAPPELIN-INTEGRATION-2026-09-09.md)).
2. The experimental `cashu` host capability with a writer lease per storage scope
   per [KEHTO.md](KEHTO.md). Without it only LNURLcash remains.
3. Resource policy: allowlist for mints, LNURLcash services and Blossom mirrors,
   HTTPS only, 3 MB limit for card images, no bearer URLs in logs.
4. Cold-start delivery of intents, default handler per archetype, one window per
   storage scope. Evidence for request and response across two intents, as
   described in UI-DESIGN section 6.
5. Persistent host store with quota and I/O fault injection for tests.

Kehto finding of 10 September 2026 (decision: shell first via the
Kehto contract):

- Inventory correction: `14a14155` is the local patch commit on branch
  `feature/cashu-capability`, base `a7e0d12f`. That is also today's
  upstream state of `kehto/web` (7 September 2026). Nothing has landed since.
  `contributions/kehto-cashu.patch` applies cleanly to upstream.
- The patch supplies `cashu:request` as its own capability, never granted
  implicitly, the service with a fixed `/v1` endpoint plan, unit `sat` only, and
  a writer lease per storage scope in the host's memory. In Paja the
  service is not yet registered. `createDevServices` and the switch list
  need the entry.
- Operation with intents: `pnpm paja` in the patched checkout, one `naddr` per
  napplet. First: signed manifests (kind 35129), a reachable relay and
  a Blossom server for the artifact. Paja has no local file install.
  Cold start delivers exactly one `inc.event` with the convention after `shell.ready`.
- Gaps versus the design: no persistent default handler per archetype
  and no chooser (ambiguity is rejected); no window-per-storage-scope
  except the Cashu lease; resource policy allows any HTTPS up to 10 MB without
  an allowlist; host store is localStorage only with a 512 KiB quota, no IndexedDB.
- Order: patch a fresh upstream checkout and build Paja, register the Cashu
  service, install both napplets signed, then add default handler,
  window lock and resource allowlist through the origin-grant hooks.

### B. Identity and signer

1. Recoverable Nappelin identity as access; guest only temporary.
2. NIP-44 in the worker or through an external signer (NIP-07 on the web, NIP-46
   or NIP-55 on Android). No private key in the iframe.
3. Compatibility adapter between the existing TCG backup and the
   Hangar contract; prove figure/stone provisioning and restore on a
   second device.

Candidate for item 2, read on 10 September 2026:
[marmot-protocol/keycast](https://github.com/marmot-protocol/keycast), MIT, Rust,
a self-hosted NIP-46 remote signer. It is the first candidate that meets the
condition the architecture sets for the external-signer path, which is signing
**and** NIP-44 encryption and decryption. `core/src/v2/policy.rs` defines
`sign_event` with an explicit list of allowed kinds, and `nip04_encrypt`,
`nip04_decrypt`, `nip44_encrypt` and `nip44_decrypt` as separate capabilities,
each scoped by recipient, for example `self_only`. A capability that is not
granted is denied, and a client can only narrow the server policy, never widen
it. The stack is a SvelteKit web UI, an Axum API and the signer; only the signer
opens the database and the root credential.

It holds no money. Cashu proofs and LNURLcash secrets stay bearer secrets in the
vault, so the separation of login key and money key is unaffected. It is also not
the backup client: the NIP-44 round trip and the Blossom side remain ours to
write.

Four points to weigh before adopting it:

- The project states in its own README that it has had no independent security
  audit.
- Host and signer are trusted with the hosted key. A browser import exposes that
  key to the web stack, so importing belongs on the host command line.
- It is another service to operate: a Linux host, Docker Compose, a hostname and
  an HTTPS reverse proxy, on top of what this list already names.
- Management needs a second, external signer. Keycast deliberately refuses to
  sign its own management approvals.

If Bearlett ever shares an instance with another application, it takes **its own
grant**, never the one issued to Hangar or to a messenger. Confirmed on
10 September 2026, and the policy is narrow by construction:

| Capability | Bearlett's grant |
| --- | --- |
| `nip44_encrypt`, `nip44_decrypt` | `recipient: self_only`, for the wallet backup and nothing else |
| `sign_event` | only what a backup reference needs; no Marmot kinds (30443, 450, 13, 10050, 445) |
| Keycast management kinds 27236 and 27237 | never granted to a wallet |

Keycast holds no money. The canonical key, the vault and any Lightning backend
stay outside it, and Cashu proofs and LNURLcash secrets never leave the vault,
so a signer compromise costs a backup key and not a balance.

The wallet backup needs `identity.nip44` from the host. Where the host cannot
provide it, the wallet fails closed: it does not create a fresh wallet, and it
does not repeat a mutation. A Hangar guest is exactly that case, because its
identity carries no `nip44` at all; see
[NAPPELIN-INTEGRATION-2026-09-09.md](NAPPELIN-INTEGRATION-2026-09-09.md).

### C. Backup transport

1. Persistent Nostr relay for signed backup references. An isolated,
   verified Bearlett relay is missing; intended is strfry on loopback 47777 with
   its own database, proposal not yet built. The 500-event limit of the
   TCG sync history has to be fixed or bypassed.
2. Encrypted snapshots on Blossom: two independent stores plus
   a file backup, upload authorisation through the signer, read-back and hash
   check before publishing the reference. Check retention and quotas of the
   mirrors.
3. Explicit device change with one writer; no relay supplies a lock.

### D. Media

1. Secure mirroring of card images onto at least two Blossom servers that
   do not depend on the same operator. Today three mirrors are configured.
   Mirroring itself is not implemented in the TCG wallet.
2. Image cache in the napplet through the storage NAP, with quota behaviour
   after restart.

### E. Lightning and BOLT12

1. cashu-ts 4.10.1 can create BOLT12 mint and melt quotes. The mint must offer
   them and signal offers with a description. Which existing mints do that
   has to be determined.
2. The regtest is tied to LND. LND does not offer native BOLT12 offers up to
   `v0.21.0-beta` (June 2026). `v0.21` forwards onion messages. Offers come only
   from the sidecar LNDK. Core Lightning, LDK and Eclair can do BOLT12
   natively. For BOLT12 tests the stack needs a CLN node in Compose and
   a mint that issues offers. That is proven for the Cashu Development Kit
   Rust mint from `v0.12.0`: BOLT12 end to end, optionally with a CLN backend
   or with `cdk-ldk-node`, which runs mint and Lightning node in one binary.
   No BOLT12 support was found for Nutshell 0.20.3.
   Consequence: for BOLT12 in regtest add a CDK mint beside Nutshell;
   for production choose existing CDK mints with a BOLT12 signal. Sources:
   <https://www.spark.money/research/lightning-network-2026-state>,
   <https://www.nobsbitcoin.com/lndk/>, <https://github.com/cashubtc/cdk/releases>,
   <https://blog.cashu.space/cashu-highlights-q3-25/>.
3. LNURLcash has no BOLT12. BOLT12 payments from LNURLcash balances go through
   the existing Lightning bridge to a Cashu mint. No new infrastructure,
   but an extra regtest path.

### F. NutFT mint for cards

Finding from `TCG600nap` `d753505`, details in [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md);
comparison with Breno's Pokémon mint in
[NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md):

- One Node process `server/table.js` (`npm run table`), port `PORT` defaulting to
  8777, plain HTTP. TLS comes from the reverse proxy: Caddy on loopback with
  `TRUST_PROXY=loopback`, systemd unit `tcg-table.service` per
  `docs/deploy-runbook-mint.md`. The mint is a library in this server,
  not its own process.
- Two instances: Edition One under the base paths, G under `/g` with its own
  SQLite file (`G_NUTFT_DB`, `G_NUTFT_FUNDING` mandatory).
- Lightning backends in `server/funding.js`: `lnd` over REST with an
  invoice macaroon, `phoenixd` (also pays out), `cashu` (custodial, staging
  only), `mock` (only with `NUTFT_ALLOW_VIRTUAL=1`), `none` as a free demo.
  Boosters are paid with BOLT11. BOLT12 sales would be new work.
- Identity: `mint_seed` and `catalog_private_key` are created on first start in
  the SQLite table `nutft_meta`. There is no key file. The
  database backup is the backup of the mint identity.
- Catalogue: `NUTFT_CATALOG_URI` points at `GET /nutft/catalog` of this mint.
  The triple of `census_sha256`, `collection_id` and `catalog_uri` is
  frozen. Any deviation refuses start.
- Live today: runbook path A as a free demo on `tcg.nappelin.com`. No mint URL
  is in the code. `site/shop.js:96` derives it from `location.origin`.

To build or operate:

1. Server with domain, Caddy and systemd; encrypted, separate backup of the
   SQLite file before the first issuance.
2. Lightning backend: phoenixd or LND with an invoice macaroon; backend access
   only from the mint host. Beacon source for draws (`NUTFT_BEACON_SOURCE`,
   `NUTFT_BEACON_CONFIRMATIONS`) on booster editions. Manifest editions such as G
   need no beacon.
3. Blossom uploads of the card images with a Nostr key
   (`scripts/upload-blobs.mjs`, BUD-02, kind 24242, `PALACE_NSEC`) onto the three
   mirrors; check presence with `scripts/check_blobs.py`.
4. Backup relay with a wallet allowlist (`TCG_WALLET_BACKUP_ALLOWLIST`,
   `server/relay-policy-patch.js`, `server/relay-wallet-allowlist.js`).
5. For the Bearlett assets napplets: mint URL and mirrors through the
   resource policy, not in code. The fixed unit list in
   `site/nutft-wallet.js` is removed on `feature/nutft-catalog-blob`, and the
   mint serves the catalogue there as a hash-addressed blob with
   `NUTFT_CATALOG_MIRRORS`; see
   [NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md), section 8.
   Open: publish the catalogue blob live and register the mirrors.
6. Hardening: `NUTFT_REQUIRE_PRODUCTION_KEYS` is documented only, not
   implemented. Set sales mode `NUTFT_SALES`, price ladder
   `NUTFT_PRICE_SCHEDULE`, invoice TTL and claim window deliberately.

### G. Test and evidence environment

1. Automate the crash matrix from INFRASTRUCTURE-2026-09-09: stop after a named
   journal checkpoint, restart with the kept store, for both transfer directions.
2. Host and browser tests with verified artifacts, own browser profiles,
   a NIP-07 or NIP-46 test signer with a synthetic identity, artifact-hash
   upgrade and intent cold start.
3. Android per Capacitor: Android Studio from 2025.2.1, JDK, SDK 36, API-36
   emulator and a real NFC-capable device for NIP-55, camera, NFC and keystore.
   Not set up. `adb reverse` for 43338, 48111, 47777; local HTTPS/WSS termination
   trusted on the device and resolvable mint hostnames.
4. Measurement of a built napplet with Three.js on a mid-range Android device.

### H. Distribution and operations

1. Signed NIP-5D manifests (kind 35129) and an install path through the shell.
   Blossom or nsite only at install and distribution, not for the regtest.
2. TLS termination and DNS for every self-operated service: NutFT mint,
   backup relay, Blossom mirror. Do not turn off certificate checks in the product.
3. GitHub Actions stay off until the client authorises them. The earlier
   authorisation check refused enabling them without asking.

## What is explicitly not built

- No sats mint of its own, neither Cashu nor LNURLcash.
- No marketplace, no prices, no HTLC swaps: Granola stays V2.
- No compare-and-swap relay for Cashu-sync; not required for V1.
- Hashtree and Envelope are optional extras, not a prerequisite for
  encrypted backups.

## Budget and order

Planning budget from the inventory, explicitly an estimate: 4 GB RAM for builds
and mints, 8 to 16 GB with Android emulator, 10 to 30 GB disk for SDK, AVD and
images, 256 MiB for a small relay. No VPS and no real sats for local
tests. For operating the NutFT mint, a relay and a Blossom mirror
a server with TLS is added; size per section F.

Recommended order: A, then B and C in parallel, then E and F, then G, last H
and Android.

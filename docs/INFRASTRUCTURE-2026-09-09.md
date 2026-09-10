# Infrastructure and reproducible test plan

As of 9 September 2026. Results and their limits are in the
[feasibility report](FEASIBILITY-2026-09-09.md). Source versions are in
[SOURCES](SOURCES-2026-09-09.md). Commands run from the repository root.
The test configuration contains only public regtest credentials.
On Windows, Docker runs inside WSL Ubuntu; pass the WSL path of this repo
to `docker compose` when the engine is not on the Windows PATH. See also
[the regtest README](../tests/integration/README.md).

## Tested stack

| Component                         | Purpose                                                                                                                     | Port / persistent data                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Node/npm                          | Builds and tests. Check run used Node 24.15.0 / npm 11.12.1. package.json names npm 12.0.2                                  | node_modules, lockfile                                                                                  |
| Docker/Compose                    | Check run used Engine 29.3.0 / Compose 5.1.0                                                                                | Local daemon, named `bearlett-regtest_*` volumes                                                        |
| Bitcoin                           | `bitcoin/bitcoin:29.0`, regtest                                                                                             | Internal only: RPC 18443, P2P 18444, ZMQ 28332/28333                                                    |
| LND Alice/Bob                     | `lightninglabs/lnd:v0.19.3-beta`; connected funded regtest channel                                                          | Each internal REST 8080, gRPC 10009, peer 9735                                                          |
| Nutshell                          | `cashubtc/nutshell:0.20.3`, LND Bob, input fee 100 PPK                                                                      | `127.0.0.1:43338` → 3338; Bob access is read-only                                                       |
| LNURLmint                         | Image `bearlett-regtest-lnurl:latest`, source `bd21f6119ee70297c127531e139d517453c26587`, LND Alice, 1 sat base fee         | `127.0.0.1:48111` → 8111; Alice access is read-only                                                     |
| Playwright/Chromium               | Package 1.63.0; 12 browser tests                                                                                            | Short-lived local preview server                                                                        |
| Kehto                             | Optional host. Patch `contributions/kehto-cashu.patch` on `kehto/web` `a7e0d12`; local patch commit was `14a14155`          | Host port from Paja output; host data/signer profile are separate                                       |
| Dedicated backup relay            | **Missing as an isolated, verified Bearlett service**                                                                       | Intended: loopback 47777, dedicated relay database                                                      |
| Cashu-sync CAS relay              | Not required for V1                                                                                                         | Dedicated process/SQLite only for a later experiment                                                    |
| Android                           | Not part of this check                                                                                                      | SDK/JDK, AVD, debug APK, keystore and app DB remain to be set up                                        |
| Go                                | Relay tests in `golang:1.26-alpine`; no host Go required                                                                    | Temporary test container                                                                                |

Local image IDs are not pullable registry digests. The running combination
was tested. A fresh build from a clean machine was not reproduced.
After the check **only the five Bearlett regtest containers were stopped**.
Named volumes were kept. Unrelated Docker projects are not part of this stack.

## Minimal environment: restart the existing regtest

`work/lnurl-mint` is gitignored. An existing image is enough to restart.
From the repository root:

```sh
docker compose -f tests/integration/compose.yaml ps -a
docker image inspect bearlett-regtest-lnurl:latest --format '{{.Id}}'
docker volume ls --filter name=bearlett-regtest
```

Leave this running in the foreground in terminal A.
`--no-recreate` keeps the Bitcoin volume mapping in particular:

```sh
docker compose -f tests/integration/compose.yaml up --no-recreate --no-build
```

In terminal B, mine a fresh block if the chain is already present and older.
A wallet that is already loaded reports a corresponding error on `loadwallet`.
Fix any other error before continuing:

```sh
docker compose -f tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only loadwallet bearlett
bearlettMiningAddress=$(docker compose -f tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only getnewaddress)
docker compose -f tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only generatetoaddress 1 "$bearlettMiningAddress"
node scripts/regtest.mjs
npm run test:regtest
```

**Reproduced start fault:** The helper does not mine new initial blocks once
height is 101 or above. On the old chain LND and Bitcoin were at the same height,
but `synced_to_chain` stayed false. The new block cleared the problem.
For a fresh chain the helper bootstraps itself with 101 blocks, funding
and channel open. The special path above is for the existing inventory.

Check status explicitly, then stop only this project:

```sh
docker compose -f tests/integration/compose.yaml exec -T alice lncli --network=regtest getinfo
docker compose -f tests/integration/compose.yaml exec -T alice lncli --network=regtest listchannels
docker compose -f tests/integration/compose.yaml stop
```

No `down -v`. No global prune. Bitcoin and LND data must be kept together
and consistent. A new Bitcoin container without the old chain is not an
allowed repair attempt for existing LND volumes.

### Fresh LNURLmint build: still to be verified separately

For a fresh checkout with no existing image, first put the missing source at
the path referenced in Compose. Run this only if the destination path does not
yet exist:

```sh
git clone https://github.com/lnurlcash/lnurl-mint.git work/lnurl-mint
git -C work/lnurl-mint checkout --detach bd21f6119ee70297c127531e139d517453c26587
docker compose -f tests/integration/compose.yaml build lnurl
```

This is a build path derived from the existing Compose configuration. It is
not a clean build that passed in this session. For a genuinely new isolated
environment first add an explicit Bitcoin volume in a **copy** of the Compose
file and stand up every service under a new project name. Do not replace the
existing environment with new volumes. Today's helper also pins the existing
Compose path: parallel stacks need an explicit configuration choice first.

## Check commands

Bearlett, each from the project root:

```sh
npm test
npm run tsc
npm run build
npm run build:napplet
npm run build:notes
npm run test:napplet:browser
npx vitest run --config docs/checks/feasibility.config.ts
npm run format:check
```

The five isolated reproductions currently confirm faults F00–F04.
They sit outside the normal test suite on purpose. They are not passing wallet
acceptance tests.

Kehto package tests: apply `contributions/kehto-cashu.patch` to a clone of
[kehto/web](https://github.com/kehto/web) at `a7e0d12`, then:

```sh
npx vitest run packages/acl packages/firewall packages/runtime packages/services packages/shell packages/paja/src/browser-devtools.test.ts --cache=false
```

Third-party snapshots used in the check are listed in
[SOURCES](SOURCES-2026-09-09.md). Clone those repositories separately.
Installs used the lockfile and skipped lifecycle scripts:

```sh
# cashu-sync wallet
npm ci --ignore-scripts
npm run test:ci -- src/sync src/v0

# granola
npm ci --ignore-scripts
npm test

# envelope
npm ci --ignore-scripts
npm test

# napplets-workshop
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm test:conformance
```

Go relay tests without installing host Go, from the cashu-sync `relay/` directory:

```sh
docker run --rm --name bearlett-spec-cas-test -v "$PWD":/src:ro -w /src golang:1.26-alpine go test ./...
```

Network access is required for dependencies. No public
`test:live` runs. No real balances. Workshop conformance does not cover
every lifecycle case and reports a warning about undeclared domains.

## Optional backup and device environment

### Ordinary relay

Plan a dedicated local relay for the next backup spike. No CAS
for the confirmed one-writer approach. The strfry setup below is a
**source-checked proposal, not yet built or end-to-end tested**.
The official Docker build files currently use Alpine 3.18.3. Recheck the
base image and build dependencies before lasting operation.

```sh
git clone https://github.com/hoytech/strfry.git
git -C strfry checkout --detach 4cd3cf64850caf47dda46c2a2abbbf3525a64d10
git -C strfry submodule update --init --recursive
# bind = "0.0.0.0" inside the container; publish only 127.0.0.1:47777 on the host
docker build -t bearlett-spec-strfry:4cd3cf6 strfry
docker run -d --name bearlett-backup-relay -p 127.0.0.1:47777:7777 \
  -v bearlett-backup-relay-db:/app/strfry-db \
  -v "$PWD/strfry.conf":/app/strfry.conf:ro \
  bearlett-spec-strfry:4cd3cf6
docker logs bearlett-backup-relay
```

Stop / start again: `docker stop bearlett-backup-relay` and
`docker start bearlett-backup-relay`. The host port stays
loopback. Container-internal `0.0.0.0` is not a public exposure here.
Keep the dedicated database. Acceptance: publish a signed NIP-78 event,
check the ACK, read it again by event ID, check signature/decryption/restore,
restart the relay and read the same state again. Bearlett's backup client for
this is still missing. Ordinary relay function is not private read access.
Test encryption and the desired auth policy separately.

### Host, signer, TLS and Android

The preview host does not replace a real Kehto/Paja test. Missing
check setup: verified Wallet/Notes artifacts, own browser profiles, explicit
Cashu/wallet permission, a NIP-07 or NIP-46 test signer with a synthetic
identity only, persistent host store with quota/I/O fault injection.
Then check artifact-hash upgrade and intent cold start. Blossom
or nsite are needed only for the matching install/distribution, not
for the mint regtest described here.

For Android, install Android Studio from 2025.2.1 plus JDK, SDK 36 and
platform-tools per the [official Capacitor environment](https://capacitorjs.com/docs/getting-started/environment-setup).
Provide an API-36 emulator plus a real NFC-capable Android device for NIP-55/Amber,
camera, NFC and hardware-backed keystore. This install and the device tests
were not run. After setup, first:

```sh
adb version
adb devices -l
adb reverse tcp:43338 tcp:43338
adb reverse tcp:48111 tcp:48111
adb reverse tcp:47777 tcp:47777
```

ADB commands are only for a locally connected debug environment. The emulator
can alternatively use `10.0.2.2` for the Windows host. On a real
phone `127.0.0.1` names the phone. Test WSL-to-Windows forwarding
first. For browser/host conformance add a local HTTPS/WSS termination trusted
on the device and mint hostnames that resolve correctly. Do not turn off
certificate checks in the product. The Node regtest's fixed
`.test` identity mappings do not solve this automatically.

Both mints answered the checked OPTIONS requests with
`Access-Control-Allow-Origin: *`. Nutshell allowed POST/content-type. That
proves preflight headers, not the full browser flow, TLS, host firewall or
every endpoint. Backup relay, quota tests and every mutation must be checked
again through the adapters actually used later.

### Resources and cost

Measured idle of the five regtest services: about **341 MiB RAM** together,
each under 0.2 % CPU at the snapshot. Image sizes: Bitcoin about 212 MB, LND
224 MB, Nutshell 1.53 GB, LNURLmint 236 MB; about 2.2 GB together, without caches.
This is not a load or Android benchmark.

Planning budget, explicitly an estimate: 4 GB RAM for builds/mints; 8–16 GB
with Android emulator; 10–30 GB extra disk for SDK/AVD/images.
A small local relay should first be measured against a 256 MiB budget.
No VPS, no paid APIs, no real sats and no store fee are required for
local tests or APK sideload. Power/download and possibly
missing test hardware remain real costs. Nothing was bought.

## Interrupt and recovery evidence still missing

Automate the same interrupt points for **both transfer directions**.
A passing Node test with MemoryStorage does not cover a process/disk
crash. Test instrumentation should stop after a named journal checkpoint,
then start with a new process/profile and the kept store.
Do not use random sleeps as the only fault trigger.

| Interrupt / fault                                  | Proven today                                                | Next required evidence                                                            |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Before reservation / failed local write            | Local fail-closed tests, but F00 confirmed in the real shim | Quota/I/O error in the host; **no** mint request after a negative commit          |
| After counter/outputs, before network              | Fixtures; F04 confirms the counter gap                      | Browser/Android kill; keep exact outputs; never reset the counter                 |
| Quote created, transfer link not yet written       | Code review, no complete crash matrix                       | Detect orphan quotes/reservations and continue or abort them safely               |
| Request sent, response lost                        | Real regtest Cashu→LNURLcash with restore, exactly one melt | Same run LNURLcash→Cashu and every immediate mint/swap/melt path                  |
| Mint confirmed, before local asset commit          | Unit fixtures; F01 shows a gap when change is missing       | Kill, NUT-07/09 recovery, correct value balance and no second payment             |
| Destination saved, before source/change completion | Journal paths reviewed, no complete device evidence         | Resume must neither credit twice nor report incomplete as complete                |
| Expired quote / unresolved payment                 | Partial unit checks                                         | Payment ban on a newly expired quote; keep already paid claims                    |
| Foreign/incomplete/old backup                      | F02/F03 reproduced                                          | Full authentication and identity before the first write; lock the old state       |
| Two tabs/writers, backup during mutation           | Instance-local leases/mutexes only                          | Shared store writer, atomic snapshot, no lost update                              |
| Handover before/after every checkpoint             | Missing                                                     | Two profiles/devices, source stays locked, lost ACKs resumable                    |
| Relay offline/old head/missing chunks              | Missing                                                     | Encrypted roundtrip, restart, consistent restore instead of silent rollbacks      |
| Signer denial/switch, activity loss                | Missing                                                     | Identity/request binding; no accidental new wallet/second payment                 |
| Android force-stop/lock/restart/NFC                | Missing                                                     | Real process kill and device, transactional store, unlock and reconcile           |

Release boundary: fix F00–F04, add official external test vectors, pass
host/browser/device tests and run an independent review.
Additional mint implementations and network failures then widen the
interoperability evidence. Granola's HTLC testnet is not a substitute for this
Lightning/bearer-wallet matrix.

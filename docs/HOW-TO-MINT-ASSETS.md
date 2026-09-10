# Minting your own assets: what it takes

As of 10 September 2026. Basis: the TCG wallet at `d753505`
(`feature/g-mint-live`), read only. All paths and line numbers refer to
that repository unless stated otherwise. Nothing here is a
security proof. The limits are in section 9.

## 1. What a card is

A NutFT card is a Cashu proof with `amount = 1` whose secret carries the tag
`["nutft", "1", collection_id, asset_id, catalog_uri, asset_binding]`.
`asset_binding` is `sha256("Cashu_NutFT_v1" ‖ canonical {collection_id,
asset_id, catalog_uri})` (`server/nutft-mint.js:30-34`). The card is bound to
the holder's key via P2BK. The keyset unit is the collection ID, for example
`600B-E1`. The keyset has exactly one amount, `1`
(`server/nutft-mint.js:452`).

Consequence: whoever wants to issue cards runs their own mint. An ordinary
Cashu mint can enforce neither the binding nor the supply. ADR 0001 sets
`server/nutft-mint.js` as the only production issuer.
`NUTFT_FUNDING=cashu` is staging only.

What is not needed: no sats mint of your own, no Lightning node of your own
if phoenixd is enough, no marketplace.

## 2. Prerequisites

| Building block              | What for                                      | Note                                                                                                                                  |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24, npm             | Mint server and JS tests                      | `npm run table` starts the server                                                                                                     |
| Python with `uv`            | Census, blob manifest, blob map, Python tests | `uv run pytest`                                                                                                                       |
| Server with domain and TLS  | Public mint                                   | Plain HTTP in the process; Caddy on loopback, `TRUST_PROXY=loopback`, systemd `tcg-table.service` (`docs/deploy-runbook-mint.md:95-99`) |
| Lightning backend           | Payment of boosters via BOLT11                | `phoenixd` or `lnd` with an invoice macaroon (`server/funding.js:88-113`); `none` for a free demo                                     |
| Nostr key for Blossom       | Upload of card images                         | `PALACE_NSEC` for `scripts/upload-blobs.mjs:15` or `BLOSSOM_SECRET_KEY` for `scripts/upload_faces.ps1:35`                             |
| Three Blossom mirrors       | Card images                                   | `blossom.primal.net`, `blossom.bimcvp.com`, `nostr.download` (`site/faces.js:25`)                                                     |
| Beacon source               | Draw on booster editions                      | `NUTFT_BEACON_SOURCE`, `NUTFT_BEACON_CONFIRMATIONS` (`server/beacon.js:88`); manifest editions need none                              |
| SQLite backup               | Mint identity                                 | Keys live only in the database, see section 6                                                                                         |

## 3. Step 1: define the edition

ADR 0003 (`docs/adr/0003-edition-isolation.md`) requires dedicated values for every
edition. Nothing may fall back to the Edition One defaults:

- `NUTFT_COLLECTION_ID`: also the keyset unit, example `600B-E1`
  (`server/nutft-mint.js:80`).
- `NUTFT_CATALOG_URI`: absolute HTTPS address of this mint's catalogue, so
  `https://<mint>/nutft/catalog` (`server/nutft-mint.js:81`, `:1108`).
- `NUTFT_CENSUS_PATH`: the census file of the edition (`server/nutft-mint.js:70`).
- `DB`: dedicated SQLite file (`server/table.js:2145`).

On `feature/g-mint-live` the wallet still checks the unit with
`/^600B-(?:E1|G)$/` (`site/nutft-wallet.js:109`). Since the branch
`feature/nutft-catalog-blob` of 10 September 2026 it accepts every
NutFT keyset, so a unit with the single amount 1. A page pins
editions through `NUTFT_UNITS`, see
[NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md), section 8.

Two issuance kinds (`server/nutft-draw.js:60`, `:96`, chosen through
`census.mint.issuance`, `:131`):

- **Booster**: draw from pools with a beacon hash, one free base card per pack.
  Edition One: 62,775 packs of 15 cards, slots 10/3/1/1, 878,931 capped
  cards, Genesis 63, Vault 189, Rare 648 (`scripts/build_mint_supply.py:50-55`).
- **Manifest**: named sets, Edition G with 210 sets of 82 cards,
  `pack_id_prefix: "set"`, 21 strong sets, at most 3 per Genesis title
  (`scripts/build_g_supply.py:44-56`).

## 4. Step 2: cards and census

1. Maintain a card list like `cards/e1-cards.json`: name, type, affinity, cost,
   rules text, flavour. This list is editorial and **not** authoritative for
   rarity.
2. Generate the census: `scripts/build_mint_supply.py` for boosters,
   `scripts/build_g_supply.py` for manifest editions. ADR 0004
   (`docs/adr/0004-mint-tier-authority.md`): the census is the only authority
   for tier, supply, pools and image hashes. Never import from
   `e1-asset-set.json`.
3. Check: `uv run pytest`, especially `tests/test_build_mint_supply.py`
   (shipped census equals generator output, pools empty evenly,
   commitment recomputable, cap declared). `node server/nutft-draw.js` checks
   itself against `cards/nutft-testvector.json`.

The census hash `census_sha256` becomes part of the mint identity. After the
first issuance it is immutable.

## 5. Step 3: artwork

1. Place card images as WebP at 5:7 into `art/cards/<edition>/`.
   Edition One lives in `art/cards/node-runner-web/`, about 157 KB per image.
2. `scripts/build_blob_manifest.py` hashes the files into
   `cards/e1-blob-manifest.json`. `scripts/build_blob_map.py` writes
   `site/blob-map.js`. Tests: `tests/test_build_blob_manifest.py`,
   `tests/test_build_blob_map.py`.
3. Upload: `node scripts/upload-blobs.mjs` (BUD-02 `PUT /upload`, authorisation
   as kind 24242, key from `PALACE_NSEC`) or `scripts/upload_faces.ps1`
   via `uvx blossom-cli upload --no-publish` with `BLOSSOM_SECRET_KEY`. Destination
   is the three mirrors. An upload limit is not configured.
4. Check: `scripts/check_blobs.py` queries every mirror. The wallet loads images
   only up to 3 MB and only when the hash matches (`site/wallet.html:364-376`).

The image hashes land as `face.sha256` in the census and thus in the catalogue.
A later image swap is a new edition.

## 6. Step 4: configure the mint

Environment variables from `server/nutft-mint.js`, `server/funding.js`,
`server/funding-cashu.js`, `server/beacon.js` and `server/table.js`:

| Variable                                                            | Meaning                                                                             | Default                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NUTFT_COLLECTION_ID`                                               | Collection ID and unit                                                              | `600B-E1`                                                                            |
| `NUTFT_CATALOG_URI`                                                 | Absolute catalogue address, required before first issuance                          | none                                                                                 |
| `NUTFT_CENSUS_PATH`                                                 | Census file                                                                         | Edition One census                                                                   |
| `NUTFT_CATALOG_MIRRORS`                                             | Blossom servers holding the catalogue blob, comma-separated; from `feature/nutft-catalog-blob` | none                                                                      |
| `DB`                                                                | SQLite file                                                                         | `server/matches.db`                                                                  |
| `PORT`                                                              | HTTP port                                                                           | `8777`                                                                               |
| `TRUST_PROXY`                                                       | Proxy trust                                                                         | `loopback` recommended                                                               |
| `PUBLIC_URL`, `NUTFT_PUBLIC_BASE`                                   | Public base address                                                                 | none                                                                                 |
| `NUTFT_FUNDING`                                                     | `lnd`, `phoenixd`, `cashu`, `mock`, `none`                                          | if unset: phoenixd when `PHOENIXD_URL` is set, else lnd when `LND_REST_URL` is set, else free |
| `PHOENIXD_URL` or `LND_REST_URL` with macaroon                      | Backend access                                                                      | none                                                                                 |
| `NUTFT_PRICE_MSAT`                                                  | Fixed price per pack                                                                | `21000`                                                                              |
| `NUTFT_PRICE_SCHEDULE`                                              | Price ladder `"2100:21000,59775:420000,…"`, price is fixed at the offer             | none                                                                                 |
| `NUTFT_SALES`                                                       | `open`, `allowlist`, `signed`, `closed`                                             | `open`                                                                               |
| `NUTFT_ALLOWLIST`, `NUTFT_ONE_PER_KEY`                              | Buyer restriction                                                                   | none                                                                                 |
| `NUTFT_INVOICE_TTL_SECONDS`                                         | Invoice window, at least 60                                                         | `900`                                                                                |
| `NUTFT_CLAIM_GRACE_SECONDS`                                         | Claim window, at least TTL                                                          | `3600`                                                                               |
| `NUTFT_RECONCILE_MS`                                                | Reconcile interval                                                                  | see `:372`                                                                           |
| `NUTFT_BEACON`, `NUTFT_BEACON_SOURCE`, `NUTFT_BEACON_CONFIRMATIONS` | Draw beacon                                                                         | none                                                                                 |
| `NUTFT_ALLOW_VIRTUAL`                                               | allows `mock`                                                                       | off                                                                                  |
| `TCG_WALLET_BACKUP_ALLOWLIST`                                       | Backup-relay allowlist                                                              | none                                                                                 |

A second instance under `/g` reads the same names with prefix `G_`
(`server/table.js:2169-2191`). `G_NUTFT_DB` and `G_NUTFT_FUNDING` are required.
The G beacon options are not wired to environment variables. G draws without a
beacon.

`NUTFT_SALES` also decides who can buy from a wallet napplet. Under `open` the
sale is anonymous and a napplet buys like any other client. Under `allowlist` or
`signed` the mint demands a NIP-98 signature, and a napplet will not produce
one: it seals its own access to a Nostr signer on purpose, because a napplet
uses the shell's signer or none at all. Gated sales therefore belong on the shop
page, and the cards are received in the napplet afterwards. See
[NAPPLETS.md](NAPPLETS.md).

Keys: on first start the mint creates `mint_seed` and
`catalog_private_key` and stores both in `nutft_meta`
(`server/nutft-mint.js:446-447`). No key file, no KMS. Back up the database
encrypted before the first issuance. After that the triple
`{census_sha256, collection_id, catalog_uri}` is frozen. Any deviation
refuses start (`:205-208`).

## 7. Step 5: start and check

```sh
npm install
npm run table
curl https://<mint>/nutft/catalog
curl https://<mint>/v1/info
npm run test:js
node server/nutft-draw.js
uv run pytest
node scripts/upload-catalog.mjs https://<mint> --go   # from feature/nutft-catalog-blob: catalogue blob onto the mirrors
```

The catalogue (`schema: 600b-nutft-catalog-v1`) contains `collection_id`,
`catalog_uri`, `census_sha256`, `assets[]` with `asset_binding`, plus
`issuer_pubkey` and a BIP-340 signature over the hash of the canonical payload
(`server/nutft-mint.js:463-481`). `/v1/info` publishes `catalog_sha256`
(`:1086`). The wallet verifies the signature and caches the catalogue for seven
days.

Tests: `tests/js/nutft.test.mjs` with 61 cases (catalogue and binding drift,
payment check, sealed packs, price ladder, sales modes),
`tests/js/gcensus.test.mjs` with 6 cases (manifest issuance, Genesis rule,
census empties exactly, Edition One untouched), plus `mint-errors`,
`relay-allowlist`, `relay-policy-patch`, `cashu-recovery`, `reveal-pages`.

## 8. Step 6: issuance and handover

- **Booster**: the buyer fetches an offer and the mint issues a BOLT11 invoice
  bound to the `pack_id`. Whether a signature is needed depends on the sales
  mode alone: `requireMayBuy` returns immediately when `NUTFT_SALES=open`
  (`server/nutft-mint.js:602-603`), so an open sale is anonymous. Under
  `allowlist` or `signed` the mint refuses with `early access` and the buyer
  retries with a NIP-98 signature (kind 27235, `server/nip98.js`). Signing every
  purchase would hand an open mint an identity it does not need.

  The paid invoice is the claim. The buyer sends `POST /nutft/booster` with
  `idempotency_key`, `pack_id`, state and one P2BK output per card. The mint
  checks each output against the expected binding, signs with DLEQ and books the
  invoice in the same transaction (`server/nutft-mint.js:890-993`). Idempotency
  hashes only the body, never the NIP-98 header (`:893-899`).
- **Manifest**: `openManifestPack` issues the named cards of a set
  (`server/nutft-draw.js:96`).
- **Trade**: `POST /nutft/trade` takes exactly one proof and returns one with
  identical binding to the new key, anonymous and without payment
  (`server/nutft-mint.js:999-1033`).

Prices: Edition One 21 sat per pack, G 210 sat per set, `input_fee_ppk: 0`
(`server/table.js:2181-2183`, `server/nutft-mint.js:874`). No routing or
platform fee in the code.

## 9. Limits and open items

- `NUTFT_REQUIRE_PRODUCTION_KEYS` lives only in `docs/mint-security-and-deploy.md`,
  not in the code. Production keys are not enforced.
- Payment only via BOLT11. A BOLT12 offer for boosters would be new backend work.
- `NUTFT_FUNDING=cashu` is custodial and intended for staging only.
- No mint URL is stored in the code. The shop page derives it from
  `location.origin` (`site/shop.js:96`). Bearlett gets it through the
  resource policy.
- The demo on `tcg.nappelin.com` is, per the runbook, a free issuance without a
  settlement, marketplace or security claim (`docs/nutft-demo.md`).
- Census, images and catalogue are fixed after the first issuance. Errors after
  that mean a new edition with its own ID, database and catalogue address.
- Breno's Pokémon PoC shows two improvements still missing here: the catalogue
  as a hash-addressed blob and a wallet library without a fixed unit list.
  Finding and adoption plan in
  [NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md).

## 10. Sources

`server/table.js`, `server/nutft-mint.js`, `server/funding.js`,
`server/funding-cashu.js`, `server/phoenixd.js`, `server/lnd.js`,
`server/nip98.js`, `server/beacon.js`, `server/nutft-draw.js`,
`server/relay-policy-patch.js`, `server/relay-wallet-allowlist.js`,
`site/nutft-wallet.js`, `site/faces.js`, `site/shop.js`, `site/wallet.html`,
`scripts/build_mint_supply.py`, `scripts/build_g_supply.py`,
`scripts/build_blob_manifest.py`, `scripts/build_blob_map.py`,
`scripts/upload-blobs.mjs`, `scripts/upload_faces.ps1`, `scripts/check_blobs.py`,
`cards/nutft-census.json`, `cards/g-census.json`, `docs/adr/0001`, `0003`, `0004`,
`docs/nutft-demo.md`, `docs/deploy-runbook-mint.md`,
`docs/mint-security-and-deploy.md`, `tests/js/*.test.mjs`, `tests/test_*.py`.

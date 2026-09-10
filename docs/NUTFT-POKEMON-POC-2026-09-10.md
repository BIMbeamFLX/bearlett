# Breno's NutFT Pokémon PoC: findings and what to adopt

10 September 2026. Source: <https://nutft-pokemon-poc.fly.dev/pokemon/>.
Only client code and endpoints were read. **The server code is not published.**
Not under brenorb's repositories. Not by GitHub code search for
`POKEMON-BASE-POC`, `pokemon-nutft-catalog-v1` or `nutft-pokemon-poc`. Everything
server-side below is derived from endpoints, not from source.

## 1. What the site is

- "Booster Club — Nut Fungible Token PoC": Pokémon Base Set, 102 cards as
  Cashu test nuts, expressly unofficial and without value. Hosted on Fly.io,
  installable as a PWA; `sw.js` caches the shell and `/blossom/<sha256>` blobs
  as immutable.
- `/v1/info`: name "600B NutFT demo mint" (the text from
  `TCG600nap/server/nutft-mint.js:1065`), version 0.1.0, NUTs 7, 9 and 31.
  NUT-31 reports `paid:false`, `funding:"none"`, `sales:"open"`, `catalog_issuer`
  and `catalog_uri = …/blossom/97781fdb…c044`.
- `/v1/keys`: one keyset, unit `POKEMON-BASE-POC`, amount 1 only.
- `/nutft/catalog` is byte-identical with the blob under `/blossom/97781f…`;
  schema `pokemon-nutft-catalog-v1`, 102 assets in the pokemontcg.io v2 card
  format plus `image_source`, `image_sha256`, `image_mime`, Schnorr-signed.
  **No** `catalog_uri`, no `census_sha256`, no `asset_binding` in the catalogue;
  the wallet derives the reference and binding itself.
- `/nutft/state`: `supply:"unlimited"`, `randomness:"mint-csprng"`, weights
  200/700/20000, slots 5 Common, 3 Uncommon, 1 Prime, 2 Energy, 11 cards per pack.
- `/nutft/quote` returns `purchase_required:true` and `cards:null`; `?deck=blackout`
  returns a fixed 60-card deck. Additional endpoints: `/nutft/eligibility`,
  `/nutft/lnurlp` ("this mint is free"), `/nutft/reveal`, `/v1/checkstate`,
  `/v1/restore`, `POST /nutft/purchase`, `/nutft/booster`, `/nutft/trade`,
  `/pokemon/events`. No `/v1/swap`, no `/v1/melt`, no `/nutft/migrate`.
- Every card image comes from the mint's own `/blossom/<sha256>` and is
  hash-checked in the client (`pokemon/app.js:33-40`).

## 2. Provenance

The site's wallet library is `TCG600nap/site/nutft-wallet.js` from Breno's
open pull request 29 (`origin/pr-29`, head `671544a`, 21 August 2026,
"feat: add NUT-09 and NUT-13 recovery") plus 97 changed lines; `schnorr.js` is
identical to our tree at `a3cc6a8`. Breno is a collaborator on the TCG repository
and author of pull requests 4 (the original NutFT mint), 23, 26 (merged), 21
(closed) and 29 (open). The PoC is therefore our mint at the PR 29 state plus
Pokémon-specific changes. Only the specification is public:
<https://github.com/brenorb/NutFT> (`31.md` as a NUT-31 draft,
`docs/demo-spec.md`, latest commit `696abc0d` of 25 August 2026).

## 3. Architecture

- Server: Node with cashu-ts lineage, state in a `.pokemon-state` directory
  (the game page asks for a backup of it). Fly configuration and tests not
  found.
- Wallet client: vanilla JS. `wallet-deps.js` (294 KB) bundles cashu-ts and
  `@scure` bip39/bip32 as `window.__cashu` and `window.__walletCrypto` and sets
  `NUTFT_UNIT = "POKEMON-BASE-POC"`, `NUTFT_STORE = "pokemon:poc:wallet"`. No
  runtime import from esm.sh; our `wallet.html` still imports
  `@cashu/cashu-ts@4.7.2` from esm.sh.
- Game: `runtime.html` (440 KB) is a real napplet with the official
  `@napplet/shim` in a `sandbox="allow-scripts"` iframe. `host.js` is the shell:
  NIP-07 or a local test key, login via a kind-22242 challenge,
  `storage.*` per pubkey, `outbox.publish/query` over `/pokemon/events` (kind 1031
  moves, kind 30078 results, all Schnorr-checked). Engine is keeshii/ryuu-play
  (MIT). `replay-view.js` verifies signed match records.
- Token format unchanged NUT-31 v1: tag
  `["nutft","1",collection_id,asset_id,catalog_uri,asset_binding]`, P2BK, amount 1,
  unit equal to collection ID, disclosed output openings, DLEQ.

## 4. Comparison

| Feature                | TCG600nap `d753505`                                                                                         | Breno PoC                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Token and binding      | NUT-31 v1                                                                                                   | identical                                                                   |
| Unit                   | `600B-E1` and `600B-G` hard-coded (`site/nutft-wallet.js:110`)                                               | globals `NUTFT_UNIT`, `NUTFT_STORE`; `catalog_uri` from `/v1/info`           |
| Catalogue address      | mutable `https://tcg.nappelin.com/nutft/catalog`, integrity via `census_sha256` and `catalog_sha256`         | immutable `/blossom/<sha256>`; wallet checks hash and signature             |
| Catalogue schema       | `600b-nutft-catalog-v1` with derived binding fields per asset                                               | metadata only: pokemontcg.io card object plus image hash                    |
| Supply and rarity      | finite census, sequential pools, beacon-sealed packs, tiers                                                 | unlimited, weighted CSPRNG, fixed slots                                     |
| Offer                  | shows the pack before the claim                                                                             | `purchase_required`, cards only after `POST /nutft/purchase`                |
| Products               | Boosters, G starter sets via a second mint under `/g`                                                       | Boosters plus four fixed 60-card decks                                      |
| Payment                | lnd, phoenixd, cashu, mock; LNURL-pay, price ladder, sale limits, one per key                               | free only                                                                   |
| Recovery               | Backup file, relay sync via bimcvp                                                                          | BIP39 plus NUT-09/NUT-13 (PR 29), backup file; no relay sync                |
| Handover UI            | Send and receive with checks, list of outgoing handovers                                                    | **none**; `tradeProof` and `importToken` exist, `app.js` never calls them   |
| Reveal                 | `reveal-pages.js`, `fx.js`                                                                                  | no choreography, no 3D                                                      |
| Image hosting          | External Blossom mirrors                                                                                    | Own `/blossom` on the mint                                                  |
| Game                   | Own engine, `play.html`, `napplet.js`                                                                       | ryuu-play as a napplet, NAP host bridge, signed events, replays             |
| Tests                  | `tests/js/*` and pytest                                                                                     | not found                                                                   |

## 5. What Breno improved

1. **Catalogue by hash.** `catalog_uri` points at the hash of the catalogue; the
   binding is therefore immutable by construction and the catalogue carries no
   derived fields.
2. **Generic wallet library.** Unit and storage key as globals, the catalogue
   address from `/v1/info`; this replaces the edition check that
   [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md) names as an obstacle.
3. **Bundled dependencies**, no CDN, PWA with offline-cached blobs.
4. **Two-phase purchase** with a client `purchase_id`; a confirmed purchase keeps
   its cards (`nutft-wallet.js:300-303`).
5. **Fixed decks** via the booster path.
6. **NUT-13 deterministic outputs and NUT-09 restore** from PR 29.
7. **`encodeToken`** (`nutft-wallet.js:308-315`) fixes cashu-ts Base64 padding for
   tokens over 32 KiB, required for 60-card tokens.
8. **Proof of possession** via `POST /nutft/reveal` with Schnorr signatures per
   proof over `{domain "NutFT-play-v1", player, room, secret}` (`:877-897`), which
   the game napplet consumes.
9. **Game as a real napplet** with the signer in the shell.

## 6. Concerns

- Server code unpublished: atomicity, spent set, purchase idempotency and CSPRNG
  are not auditable.
- No scarcity, no verifiable randomness, no beacon.
- Pokémon rights: data from pokemontcg.io and images from TCGdex are rehosted on
  the mint, with a disclaimer only; both sources name the rights explicitly as
  Pokémon Company, Nintendo, Creatures and GAME FREAK.
- Dropped: handover UI, paid path, sale limits, relay sync, reveal choreography,
  tests, multi-mint prefix.
- Catalogue and blobs live only on the mint itself, without mirrors.
- Restore scans the entire catalogue index space (`:784-857`); uncritical at 102
  cards, slow at 295 and above.
- Import reissues every received proof individually, one swap per proof, abort on
  the first error (`:749-767`).
- Cosmetics: error text still says "600B-E1", `catalogUri` is special-cased for
  `UNIT === "600B-E1"`.

## 7. Adoption here

Provisional. The order will be set after the check of LNURLcash assets and the
Blossom status (see section 8).

| No. | Adoption                                                                                                         | Target                                                                              | Effort and risk                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Catalogue as a hash-addressed blob on real Blossom servers, `catalog_uri` with hash, `/v1/info` advertises them  | `TCG600nap/server/nutft-mint.js` (catalogue, info), upload scripts                   | medium; the mint identity triple changes, therefore only for new editions |
| 2   | Wallet library generic: unit from `/v1/keys`, catalogue address from `/v1/info`, storage key per unit            | `TCG600nap/site/nutft-wallet.js:109` and callers; later `nutft-vault` in Bearlett    | small to medium; tests exist                                              |
| 3   | `encodeToken` fix for large tokens                                                                               | `TCG600nap/site/nutft-wallet.js`                                                    | small                                                                     |
| 4   | NUT-09 and NUT-13                                                                                                | Review and merge PR 29 in the TCG repository                                        | owner's review decision                                                   |
| 5   | Two-phase purchase without showing the cards in advance                                                          | `server/nutft-mint.js` offer and booster path                                       | medium to high; touches beacon-sealed packs, idempotency and payment      |
| 6   | Proof of possession per proof                                                                                    | `server/nutft-mint.js`, wallet, later `card/provenance` in Bearlett                  | medium                                                                    |
| 7   | Bundled dependencies instead of esm.sh                                                                           | `site/wallet.html`                                                                  | small                                                                     |
| 8   | Game as a napplet with shell signer                                                                              | A separate undertaking, not part of this adoption                                   | large                                                                     |

Not adopted: unlimited supply, CSPRNG without a beacon, blobs only on the mint,
rehosted third-party rights.

## 8. Implemented on 10 September 2026

Branch `feature/nutft-catalog-blob` in `TCG600nap`, based on
`feature/g-mint-live`; 434 tests green, 431 existing and 3 new.

- **Adoption 1**, in the form that allows existing editions: the mint signs the
  catalogue deterministically (BIP-340 with zero aux), freezes the bytes at
  start, serves them under `/nutft/catalog` and `/blossom/<sha256>`, and
  advertises in `/v1/info` the fields `catalog_uri`, `catalog_blob_sha256` and
  `catalog_blob_urls`; mirrors come from `NUTFT_CATALOG_MIRRORS`, for G from
  `G_NUTFT_CATALOG_MIRRORS`. The catalogue address remains the identity. The blob
  is the transport. For new editions, `catalog_uri` itself may be a Blossom
  address.
- **Adoption 2**: `site/nutft-wallet.js` accepts any NutFT keyset, i.e. a unit
  with the single amount 1, optionally restricted via `NUTFT_UNITS`;
  `NUTFT_STORE` is selectable. The wallet fetches the catalogue first by hash
  from the mint, then from the mirrors, checks the bytes against the hash, and
  only then falls back to the catalogue address.
- **Adoption 3**: `encodeToken` for tokens over 32 KiB. The cashu-ts 4.7.2 bug
  was verified on the package: Base64 in blocks of 32,768 bytes
  (`lib/cashu-ts.es.js:184-192`); 4.10.1 no longer has the block split.
- New: `scripts/blossom-auth.mjs` (BUD-11, base64url without padding) and
  `scripts/upload-catalog.mjs` (BUD-02 upload of the catalogue blob, check per
  mirror, requires at least two); README section "Content-addressed
  publishing" extended.
- Tests: `tests/js/nutft-catalog-blob.test.mjs` (blob route, determinism across
  a restart, wallet path with a tampered blob and fallback, foreign unit,
  allowlist, tokens over 32 KiB) and `tests/js/helpers/browser-wallet.mjs`.

Not implemented: two-phase purchase and decks (4, 5), proof of possession (6),
bundling of dependencies (7); the specification for 4 and 6 is in
`TCG600nap/docs/nutft-purchase-and-possession.md`. On GitHub: `main` is
fast-forwarded to the live state, the catalogue blob is PR 30 against `main`, and
Breno's PR 29 is rebased as PR 31 onto the catalogue blob, with two follow-up
commits (restore in the keyset unit, catalogue check against the keyset); 436
tests green.

## 9. Checks: LNURLcash and Blossom

### 9.1 Cards over LNURLcash instead of Cashu

Result: **no**, not without a protocol extension of our own. Findings of 10
September 2026 against `lnurlcash/lnurl-wallet` (`6088135`, v0.10.7) and
`lnurlcash/lnurl-mint` (`bd21f61`, v0.6.1):

- "Asset" for dni is the bearer note itself, fungible millisats; LUD-25 is
  titled "Bearer assets". No field for asset ID, unit, metadata, image or
  uniqueness in the data model (`lnurl_mint/db.py:56-62`, `src/storage.ts:27-58`).
- The newest features are note tags (#116) and addons (#117, alpha): local
  labels and manifests, none of that on the wire.
- Our earlier asset layer (`lnurlcash/lnurl-mint#1`, NORD) was closed unmerged
  on 8 August 2026; none of it is on `main`.
- LUD-25 (`lnurl/luds`, branch `lnurlcash`, `ff65c09b` of 10 September 2026,
  part 2 rewritten): `cs1` signs amount and key, no asset fields.
- Versus NutFT, binding hash, recipient lock (P2BK), DLEQ and blind signatures
  are missing; the service sees every rotation; split and merge are always
  allowed.

Consequence: LNURLcash remains the rail for sats in _Pay_. Cards remain
Cashu NutFT.

### 9.2 Assets on Blossom after hzrd149

Status `hzrd149/blossom` `b5bd280` (15 June 2026), all BUDs draft: BUD-01
GET and HEAD, BUD-02 upload, BUD-03 server list kind 10063, BUD-04 `PUT /mirror`,
BUD-10 `blossom:` URI (since November 2025), BUD-11 auth kind 24242 with
base64url, BUD-12 list and delete. Server `hzrd149/blossom-server` 6.3.0 (Deno 2,
MIT, rules per pubkey and MIME, mirroring, no BUD-07); local clone
`G:\Github\blossom-server` at `1730b08`. `blossom.bimcvp.com` accepts
`application/json`; whether `blossom.primal.net` and `nostr.download` accept JSON
is not verified. Implemented: see section 8. Open: mirroring via BUD-04 instead
of multi-upload in `upload-blobs.mjs`, kind 10063 for the issuer,
`check_blobs.py` with at least two servers per hash, publish the catalogue blob
live and enter the mirrors in `NUTFT_CATALOG_MIRRORS`.

## 10. Sources

Site and endpoints: `/v1/info`, `/v1/keys`, `/nutft/catalog`, `/nutft/state`,
`/nutft/quote`, `/nutft-wallet.js`, `/pokemon/app.js`, `/pokemon/host.js`,
`/pokemon/sw.js`, `/pokemon/runtime.html`, `/pokemon/engine.mjs`.
<https://github.com/brenorb/NutFT>,
<https://github.com/BIMbeamFLX/600BillionTimelockTCG/pull/29>,
<https://github.com/keeshii/ryuu-play>, <https://tcgdex.dev/faq>,
<https://dev.pokemontcg.io/terms>. Local: `TCG600nap/server/nutft-mint.js`,
`site/nutft-wallet.js`, `site/wallet.html`, `docs/adr/0001` to `0004`,
`docs/deploy-runbook-mint.md`.
LNURLcash: <https://github.com/lnurlcash/lnurl-wallet>,
<https://github.com/lnurlcash/lnurl-mint>, <https://github.com/lnurlcash/lnurl-mint/pull/1>,
<https://github.com/lnurl/luds/blob/lnurlcash/25.md>. Blossom:
<https://github.com/hzrd149/blossom>, <https://github.com/hzrd149/blossom-server>,
<https://github.com/hzrd149/blossom-client-sdk>,
<https://github.com/nostr-protocol/nips/blob/master/B7.md>. cashu-ts 4.7.2:
`lib/cashu-ts.es.js` from the npm tarball.

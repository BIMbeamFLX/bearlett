# Eigene Assets minten: was es braucht

Stand: 10. September 2026. Grundlage: `G:\Github\TCG600nap` `d753505`
(`feature/g-mint-live`), nur gelesen. Alle Pfade und Zeilen beziehen sich auf
dieses Repository, sofern nicht anders angegeben. Nichts hier ist ein
Sicherheitsnachweis; die Grenzen stehen in Abschnitt 9.

## 1. Was eine Karte ist

Eine NutFT-Karte ist ein Cashu-Proof mit `amount = 1`, dessen Secret den Tag
`["nutft", "1", collection_id, asset_id, catalog_uri, asset_binding]` trägt.
`asset_binding` ist `sha256("Cashu_NutFT_v1" ‖ kanonisches {collection_id,
asset_id, catalog_uri})` (`server/nutft-mint.js:30-34`). Die Karte ist per P2BK an
den Schlüssel des Halters gebunden. Die Keyset-Einheit ist die Sammlungs-ID, zum
Beispiel `600B-E1`; das Keyset hat genau einen Betrag, `1`
(`server/nutft-mint.js:452`).

Daraus folgt: Wer Karten ausgeben will, betreibt eine eigene Mint. Eine gewöhnliche
Cashu-Mint kann weder die Bindung noch die Auflage durchsetzen. ADR 0001 legt
`server/nutft-mint.js` als einzigen produktiven Aussteller fest;
`NUTFT_FUNDING=cashu` ist nur Staging.

Was nicht gebraucht wird: keine eigene Sats-Mint, kein eigener Lightning-Knoten,
wenn phoenixd genügt, kein Marktplatz.

## 2. Voraussetzungen

| Baustein                    | Wofür                                         | Hinweis                                                                                                                               |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24, npm             | Mint-Server und JS-Tests                      | `npm run table` startet den Server                                                                                                    |
| Python mit `uv`             | Zensus, Blob-Manifest, Blob-Map, Python-Tests | `uv run pytest`                                                                                                                       |
| Server mit Domain und TLS   | Öffentliche Mint                              | Reines HTTP im Prozess; Caddy auf Loopback, `TRUST_PROXY=loopback`, systemd `tcg-table.service` (`docs/deploy-runbook-mint.md:95-99`) |
| Lightning-Backend           | Bezahlung der Booster per BOLT11              | `phoenixd` oder `lnd` mit Invoice-Macaroon (`server/funding.js:88-113`); `none` für eine Gratis-Demo                                  |
| Nostr-Schlüssel für Blossom | Upload der Kartenbilder                       | `PALACE_NSEC` für `scripts/upload-blobs.mjs:15` oder `BLOSSOM_SECRET_KEY` für `scripts/upload_faces.ps1:35`                           |
| Drei Blossom-Spiegel        | Kartenbilder                                  | `blossom.primal.net`, `blossom.bimcvp.com`, `nostr.download` (`site/faces.js:25`)                                                     |
| Beacon-Quelle               | Ziehung bei Booster-Editionen                 | `NUTFT_BEACON_SOURCE`, `NUTFT_BEACON_CONFIRMATIONS` (`server/beacon.js:88`); Manifest-Editionen brauchen keinen                       |
| SQLite-Backup               | Mint-Identität                                | Schlüssel liegen nur in der Datenbank, siehe Abschnitt 6                                                                              |

## 3. Schritt 1: Edition festlegen

ADR 0003 (`docs/adr/0003-edition-isolation.md`) verlangt für jede Edition eigene
Werte, nichts darf auf die Edition-One-Standardwerte zurückfallen:

- `NUTFT_COLLECTION_ID`: zugleich Keyset-Einheit, Beispiel `600B-E1`
  (`server/nutft-mint.js:80`).
- `NUTFT_CATALOG_URI`: absolute HTTPS-Adresse des eigenen Katalogs, also
  `https://<mint>/nutft/catalog` (`server/nutft-mint.js:81`, `:1108`).
- `NUTFT_CENSUS_PATH`: die Zensusdatei der Edition (`server/nutft-mint.js:70`).
- `DB`: eigene SQLite-Datei (`server/table.js:2145`).

Die Wallet prüft die Einheit mit `/^600B-(?:E1|G)$/` (`site/nutft-wallet.js:109`).
Eine neue Einheit braucht diese Änderung in der Wallet, später ebenso in den
Bearlett-Assets-Napplets.

Zwei Ausgabearten (`server/nutft-draw.js:60`, `:96`, Auswahl über
`census.mint.issuance`, `:131`):

- **Booster**: Ziehung aus Pools mit Beacon-Hash, eine freie Basiskarte je Pack.
  Edition One: 62.775 Packs mit 15 Karten, Slots 10/3/1/1, 878.931 gedeckelte
  Karten, Genesis 63, Vault 189, Rare 648 (`scripts/build_mint_supply.py:50-55`).
- **Manifest**: benannte Sets, Edition G mit 210 Sets zu 82 Karten,
  `pack_id_prefix: "set"`, 21 starke Sets, höchstens 3 je Genesis-Titel
  (`scripts/build_g_supply.py:44-56`).

## 4. Schritt 2: Karten und Zensus

1. Kartenliste wie `cards/e1-cards.json` pflegen: Name, Typ, Affinität, Kosten,
   Regeltext, Flavor. Diese Liste ist redaktionell und **nicht** maßgeblich für
   Seltenheit.
2. Zensus erzeugen: `scripts/build_mint_supply.py` für Booster,
   `scripts/build_g_supply.py` für Manifest-Editionen. ADR 0004
   (`docs/adr/0004-mint-tier-authority.md`): der Zensus ist die einzige Autorität
   für Tier, Auflage, Pools und Bild-Hashes; nie aus `e1-asset-set.json`
   importieren.
3. Prüfen: `uv run pytest`, insbesondere `tests/test_build_mint_supply.py`
   (ausgelieferter Zensus gleich Generatorausgabe, Pools leeren sich gleichmäßig,
   Commitment nachrechenbar, Deckel deklariert). `node server/nutft-draw.js` prüft
   sich selbst gegen `cards/nutft-testvector.json`.

Der Zensus-Hash `census_sha256` wird Teil der Mint-Identität. Nach der ersten
Ausgabe ist er unveränderlich.

## 5. Schritt 3: Artwork

1. Kartenbilder als WebP im Verhältnis 5:7 nach `art/cards/<edition>/` legen.
   Edition One liegt in `art/cards/node-runner-web/`, etwa 157 KB je Bild.
2. `scripts/build_blob_manifest.py` hasht die Dateien nach
   `cards/e1-blob-manifest.json`; `scripts/build_blob_map.py` schreibt
   `site/blob-map.js`. Tests: `tests/test_build_blob_manifest.py`,
   `tests/test_build_blob_map.py`.
3. Hochladen: `node scripts/upload-blobs.mjs` (BUD-02 `PUT /upload`, Autorisierung
   als Kind 24242, Schlüssel aus `PALACE_NSEC`) oder `scripts/upload_faces.ps1`
   über `uvx blossom-cli upload --no-publish` mit `BLOSSOM_SECRET_KEY`. Ziel sind
   die drei Spiegel; ein Upload-Limit ist nicht konfiguriert.
4. Prüfen: `scripts/check_blobs.py` fragt alle Spiegel ab. Die Wallet lädt Bilder
   nur bis 3 MB und nur bei passendem Hash (`site/wallet.html:364-376`).

Die Bild-Hashes landen als `face.sha256` im Zensus und damit im Katalog. Ein
späterer Bildtausch ist eine neue Edition.

## 6. Schritt 4: Mint konfigurieren

Umgebungsvariablen aus `server/nutft-mint.js`, `server/funding.js`,
`server/funding-cashu.js`, `server/beacon.js` und `server/table.js`:

| Variable                                                            | Bedeutung                                                                  | Standard                                                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `NUTFT_COLLECTION_ID`                                               | Sammlungs-ID und Einheit                                                   | `600B-E1`                                                                            |
| `NUTFT_CATALOG_URI`                                                 | Absolute Katalogadresse, Pflicht vor der ersten Ausgabe                    | keiner                                                                               |
| `NUTFT_CENSUS_PATH`                                                 | Zensusdatei                                                                | Edition-One-Zensus                                                                   |
| `DB`                                                                | SQLite-Datei                                                               | `server/matches.db`                                                                  |
| `PORT`                                                              | HTTP-Port                                                                  | `8777`                                                                               |
| `TRUST_PROXY`                                                       | Proxy-Vertrauen                                                            | `loopback` empfohlen                                                                 |
| `PUBLIC_URL`, `NUTFT_PUBLIC_BASE`                                   | Öffentliche Basisadresse                                                   | keiner                                                                               |
| `NUTFT_FUNDING`                                                     | `lnd`, `phoenixd`, `cashu`, `mock`, `none`                                 | ohne Angabe: phoenixd bei `PHOENIXD_URL`, sonst lnd bei `LND_REST_URL`, sonst Gratis |
| `PHOENIXD_URL` oder `LND_REST_URL` mit Macaroon                     | Backend-Zugang                                                             | keiner                                                                               |
| `NUTFT_PRICE_MSAT`                                                  | Festpreis je Pack                                                          | `21000`                                                                              |
| `NUTFT_PRICE_SCHEDULE`                                              | Preisleiter `"2100:21000,59775:420000,…"`, Preis wird beim Angebot fixiert | keine                                                                                |
| `NUTFT_SALES`                                                       | `open`, `allowlist`, `signed`, `closed`                                    | `open`                                                                               |
| `NUTFT_ALLOWLIST`, `NUTFT_ONE_PER_KEY`                              | Käuferbeschränkung                                                         | keine                                                                                |
| `NUTFT_INVOICE_TTL_SECONDS`                                         | Rechnungsfrist, mindestens 60                                              | `900`                                                                                |
| `NUTFT_CLAIM_GRACE_SECONDS`                                         | Abholfrist, mindestens TTL                                                 | `3600`                                                                               |
| `NUTFT_RECONCILE_MS`                                                | Abgleichintervall                                                          | siehe `:372`                                                                         |
| `NUTFT_BEACON`, `NUTFT_BEACON_SOURCE`, `NUTFT_BEACON_CONFIRMATIONS` | Ziehungs-Beacon                                                            | keiner                                                                               |
| `NUTFT_ALLOW_VIRTUAL`                                               | erlaubt `mock`                                                             | aus                                                                                  |
| `TCG_WALLET_BACKUP_ALLOWLIST`                                       | Backup-Relay-Allowlist                                                     | keine                                                                                |

Eine zweite Instanz unter `/g` liest dieselben Namen mit Präfix `G_`
(`server/table.js:2169-2191`); `G_NUTFT_DB` und `G_NUTFT_FUNDING` sind Pflicht.
Die G-Beacon-Optionen sind nicht an Umgebungsvariablen angebunden; G zieht ohne
Beacon.

Schlüssel: Beim ersten Start erzeugt die Mint `mint_seed` und
`catalog_private_key` und legt beide in `nutft_meta` ab
(`server/nutft-mint.js:446-447`). Keine Schlüsseldatei, kein KMS. Vor der ersten
Ausgabe die Datenbank verschlüsselt sichern; danach ist das Tripel
`{census_sha256, collection_id, catalog_uri}` eingefroren, jede Abweichung
verweigert den Start (`:205-208`).

## 7. Schritt 5: Starten und prüfen

```sh
npm install
npm run table
curl https://<mint>/nutft/catalog
curl https://<mint>/v1/info
npm run test:js
node server/nutft-draw.js
uv run pytest
```

Der Katalog (`schema: 600b-nutft-catalog-v1`) enthält `collection_id`,
`catalog_uri`, `census_sha256`, `assets[]` mit `asset_binding`, dazu
`issuer_pubkey` und eine BIP-340-Signatur über den Hash der kanonischen Nutzlast
(`server/nutft-mint.js:463-481`). `/v1/info` veröffentlicht `catalog_sha256`
(`:1086`). Die Wallet verifiziert die Signatur und cached den Katalog sieben Tage.

Tests: `tests/js/nutft.test.mjs` mit 61 Fällen (Katalog- und Bindungsdrift,
Zahlungsprüfung, versiegelte Packs, Preisleiter, Verkaufsmodi),
`tests/js/gcensus.test.mjs` mit 6 Fällen (Manifest-Ausgabe, Genesis-Regel,
Zensus leert sich exakt, Edition One unberührt), dazu `mint-errors`,
`relay-allowlist`, `relay-policy-patch`, `cashu-recovery`, `reveal-pages`.

## 8. Schritt 6: Ausgabe und Übergabe

- **Booster**: Der Käufer holt mit NIP-98-Signatur (Kind 27235,
  `server/nip98.js`) ein Angebot; die Mint gibt eine BOLT11-Rechnung, gebunden an
  die `pack_id`. Die bezahlte Rechnung ist der Anspruch. Der Käufer sendet
  `POST /nutft/booster` mit `idempotency_key`, `pack_id`, Zustand und je Karte
  einem P2BK-Output; die Mint prüft jeden Output gegen die erwartete Bindung,
  signiert mit DLEQ und verbucht die Rechnung in derselben Transaktion
  (`server/nutft-mint.js:890-993`). Die Idempotenz hasht nur den Body, nie den
  NIP-98-Header (`:893-899`).
- **Manifest**: `openManifestPack` gibt die benannten Karten eines Sets aus
  (`server/nutft-draw.js:96`).
- **Tausch**: `POST /nutft/trade` nimmt genau einen Proof und gibt einen mit
  identischer Bindung an den neuen Schlüssel zurück, anonym und ohne Zahlung
  (`server/nutft-mint.js:999-1033`).

Preise: Edition One 21 sat je Pack, G 210 sat je Set, `input_fee_ppk: 0`
(`server/table.js:2181-2183`, `server/nutft-mint.js:874`). Keine Routing- oder
Plattformgebühr im Code.

## 9. Grenzen und offene Punkte

- `NUTFT_REQUIRE_PRODUCTION_KEYS` steht nur in `docs/mint-security-and-deploy.md`,
  nicht im Code. Produktionsschlüssel werden nicht erzwungen.
- Bezahlung nur per BOLT11. Ein BOLT12-Angebot für Booster wäre Neubau im Backend.
- `NUTFT_FUNDING=cashu` ist custodial und nur für Staging gedacht.
- Im Code ist keine Mint-URL hinterlegt; die Shop-Seite leitet sie aus
  `location.origin` ab (`site/shop.js:96`). Bearlett bekommt sie über die
  Resource-Policy.
- Die Demo auf `tcg.nappelin.com` ist laut Runbook eine Gratis-Ausgabe ohne
  Settlement-, Marktplatz- oder Sicherheitsanspruch (`docs/nutft-demo.md`).
- Zensus, Bilder und Katalog sind nach der ersten Ausgabe fest. Fehler danach
  bedeuten eine neue Edition mit eigener ID, Datenbank und Katalogadresse.
- Brenos Pokémon-PoC zeigt zwei Verbesserungen, die hier noch fehlen: den Katalog
  als hashadressierten Blob und eine Wallet-Bibliothek ohne feste Einheitenliste.
  Befund und Übernahmeplan in
  [NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md).

## 10. Quellen

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

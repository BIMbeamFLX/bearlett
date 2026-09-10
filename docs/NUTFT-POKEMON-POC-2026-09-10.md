# Brenos NutFT-Pokémon-PoC: Befund und Übernahme

Stand: 10. September 2026. Quelle: <https://nutft-pokemon-poc.fly.dev/pokemon/>,
nur Client-Code und Endpunkte gelesen. **Der Server-Code ist nicht veröffentlicht**;
weder unter brenorbs Repositories noch per GitHub-Codesuche nach
`POKEMON-BASE-POC`, `pokemon-nutft-catalog-v1` oder `nutft-pokemon-poc`. Alles
Serverseitige unten ist aus Endpunkten abgeleitet, nicht aus Quelltext.

## 1. Was die Seite ist

- "Booster Club — Nut Fungible Token PoC": Pokémon Base Set, 102 Karten als
  Cashu-Testnuts, ausdrücklich inoffiziell und ohne Wert. Gehostet auf Fly.io,
  installierbar als PWA; `sw.js` cached die Shell und `/blossom/<sha256>`-Blobs
  als unveränderlich.
- `/v1/info`: Name "600B NutFT demo mint" (der Text aus
  `TCG600nap/server/nutft-mint.js:1065`), Version 0.1.0, NUTs 7, 9 und 31.
  NUT-31 meldet `paid:false`, `funding:"none"`, `sales:"open"`, `catalog_issuer`
  und `catalog_uri = …/blossom/97781fdb…c044`.
- `/v1/keys`: ein Keyset, Einheit `POKEMON-BASE-POC`, nur Betrag 1.
- `/nutft/catalog` ist byteidentisch mit dem Blob unter `/blossom/97781f…`;
  Schema `pokemon-nutft-catalog-v1`, 102 Assets im Kartenformat von
  pokemontcg.io v2 plus `image_source`, `image_sha256`, `image_mime`,
  Schnorr-signiert. **Kein** `catalog_uri`, kein `census_sha256`, kein
  `asset_binding` im Katalog; die Wallet leitet Referenz und Bindung selbst ab.
- `/nutft/state`: `supply:"unlimited"`, `randomness:"mint-csprng"`, Gewichte
  200/700/20000, Slots 5 Common, 3 Uncommon, 1 Prime, 2 Energy, 11 Karten je Pack.
- `/nutft/quote` liefert `purchase_required:true` und `cards:null`; `?deck=blackout`
  gibt ein festes 60-Karten-Deck. Endpunkte zusätzlich: `/nutft/eligibility`,
  `/nutft/lnurlp` ("this mint is free"), `/nutft/reveal`, `/v1/checkstate`,
  `/v1/restore`, `POST /nutft/purchase`, `/nutft/booster`, `/nutft/trade`,
  `/pokemon/events`. Kein `/v1/swap`, kein `/v1/melt`, kein `/nutft/migrate`.
- Jedes Kartenbild kommt vom eigenen `/blossom/<sha256>` der Mint und wird im
  Client per Hash geprüft (`pokemon/app.js:33-40`).

## 2. Herkunft

Die Wallet-Bibliothek der Seite ist `TCG600nap/site/nutft-wallet.js` aus Brenos
offenem Pull Request 29 (`origin/pr-29`, Head `671544a`, 21. August 2026,
"feat: add NUT-09 and NUT-13 recovery") plus 97 geänderte Zeilen; `schnorr.js` ist
identisch mit unserem Stand `a3cc6a8`. Breno ist Collaborator im TCG-Repository und
Autor der Pull Requests 4 (die ursprüngliche NutFT-Mint), 23, 26 (gemergt), 21
(geschlossen) und 29 (offen). Der PoC ist also unsere Mint auf dem Stand von PR 29
plus Pokémon-spezifische Änderungen. Öffentlich ist nur die Spezifikation:
<https://github.com/brenorb/NutFT> (`31.md` als NUT-31-Entwurf,
`docs/demo-spec.md`, letzter Commit `696abc0d` vom 25. August 2026).

## 3. Architektur

- Server: Node mit cashu-ts-Abstammung, Zustand in einem `.pokemon-state`-Verzeichnis
  (die Spielseite bittet um dessen Sicherung). Fly-Konfiguration und Tests nicht
  gefunden.
- Wallet-Client: Vanilla JS. `wallet-deps.js` (294 KB) bündelt cashu-ts und
  `@scure` bip39/bip32 als `window.__cashu` und `window.__walletCrypto` und setzt
  `NUTFT_UNIT = "POKEMON-BASE-POC"`, `NUTFT_STORE = "pokemon:poc:wallet"`. Kein
  Laufzeit-Import von esm.sh; unsere `wallet.html` importiert weiterhin
  `@cashu/cashu-ts@4.7.2` von esm.sh.
- Spiel: `runtime.html` (440 KB) ist ein echtes Napplet mit dem offiziellen
  `@napplet/shim` im `sandbox="allow-scripts"`-iframe. `host.js` ist die Shell:
  NIP-07 oder lokaler Testschlüssel, Anmeldung per Kind-22242-Challenge,
  `storage.*` je Pubkey, `outbox.publish/query` über `/pokemon/events` (Kind 1031
  Züge, Kind 30078 Ergebnisse, alle schnorr-geprüft). Engine ist keeshii/ryuu-play
  (MIT). `replay-view.js` prüft signierte Partieaufzeichnungen.
- Token-Format unverändert NUT-31 v1: Tag
  `["nutft","1",collection_id,asset_id,catalog_uri,asset_binding]`, P2BK, Betrag 1,
  Einheit gleich Sammlungs-ID, offengelegte Output-Openings, DLEQ.

## 4. Vergleich

| Merkmal                | TCG600nap `d753505`                                                                                         | Breno-PoC                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Token und Bindung      | NUT-31 v1                                                                                                   | identisch                                                                   |
| Einheit                | `600B-E1` und `600B-G` hart kodiert (`site/nutft-wallet.js:110`)                                            | Globals `NUTFT_UNIT`, `NUTFT_STORE`; `catalog_uri` aus `/v1/info`           |
| Katalogadresse         | veränderlich `https://tcg.nappelin.com/nutft/catalog`, Integrität über `census_sha256` und `catalog_sha256` | unveränderlich `/blossom/<sha256>`; Wallet prüft Hash und Signatur          |
| Katalogschema          | `600b-nutft-catalog-v1` mit abgeleiteten Bindungsfeldern je Asset                                           | reine Metadaten: pokemontcg.io-Kartenobjekt plus Bild-Hash                  |
| Auflage und Seltenheit | endlicher Zensus, sequenzielle Pools, beacon-versiegelte Packs, Tiers                                       | unbegrenzt, gewichteter CSPRNG, feste Slots                                 |
| Angebot                | zeigt das Pack vor dem Claim                                                                                | `purchase_required`, Karten erst nach `POST /nutft/purchase`                |
| Produkte               | Booster, G-Startersets über zweite Mint unter `/g`                                                          | Booster plus vier feste 60-Karten-Decks                                     |
| Bezahlung              | lnd, phoenixd, cashu, mock; LNURL-pay, Preisleiter, Verkaufsschranken, eins je Schlüssel                    | nur kostenlos                                                               |
| Wiederherstellung      | Backup-Datei, Relay-Sync über bimcvp                                                                        | BIP39 plus NUT-09/NUT-13 (PR 29), Backup-Datei; kein Relay-Sync             |
| Übergabe-UI            | Senden und Empfangen mit Prüfung, Liste ausgehender Übergaben                                               | **keine**; `tradeProof` und `importToken` existieren, `app.js` ruft sie nie |
| Aufdecken              | `reveal-pages.js`, `fx.js`                                                                                  | keine Choreografie, kein 3D                                                 |
| Bildhosting            | externe Blossom-Spiegel                                                                                     | eigenes `/blossom` auf der Mint                                             |
| Spiel                  | eigene Engine, `play.html`, `napplet.js`                                                                    | ryuu-play als Napplet, NAP-Host-Brücke, signierte Ereignisse, Replays       |
| Tests                  | `tests/js/*` und pytest                                                                                     | nicht gefunden                                                              |

## 5. Was Breno verbessert hat

1. **Katalog per Hash.** `catalog_uri` verweist auf den Hash des Katalogs; die
   Bindung ist damit konstruktionsbedingt unveränderlich und der Katalog trägt
   keine abgeleiteten Felder.
2. **Generische Wallet-Bibliothek.** Einheit und Speicherschlüssel als Globals, die
   Katalogadresse aus `/v1/info`; das ersetzt die Editions-Prüfung, die
   [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md) als Hindernis nennt.
3. **Gebündelte Abhängigkeiten**, kein CDN, PWA mit offline gecachten Blobs.
4. **Zweiphasiger Kauf** mit Client-`purchase_id`; ein bestätigter Kauf behält seine
   Karten (`nutft-wallet.js:300-303`).
5. **Feste Decks** über den Booster-Pfad.
6. **NUT-13 deterministische Outputs und NUT-09-Restore** aus PR 29.
7. **`encodeToken`** (`nutft-wallet.js:308-315`) behebt das Base64-Padding von
   cashu-ts für Token über 32 KiB, nötig für 60-Karten-Token.
8. **Besitznachweis** per `POST /nutft/reveal` mit Schnorr-Signaturen je Proof
   über `{domain "NutFT-play-v1", player, room, secret}` (`:877-897`), den das
   Spiel-Napplet konsumiert.
9. **Spiel als echtes Napplet** mit Signer in der Shell.

## 6. Bedenken

- Server-Code unveröffentlicht: Atomarität, Spent-Set, Kauf-Idempotenz und CSPRNG
  sind nicht prüfbar.
- Keine Verknappung, keine prüfbare Zufälligkeit, kein Beacon.
- Pokémon-Rechte: Daten von pokemontcg.io und Bilder von TCGdex werden auf der
  Mint umgehostet, nur mit Disclaimer; beide Quellen nennen die Rechte ausdrücklich
  Pokémon Company, Nintendo, Creatures und GAME FREAK.
- Entfallen: Übergabe-UI, bezahlter Pfad, Verkaufsschranken, Relay-Sync,
  Reveal-Choreografie, Tests, Mehr-Mint-Präfix.
- Katalog und Blobs liegen nur auf der Mint selbst, ohne Spiegel.
- Restore durchsucht den gesamten Katalog-Indexraum (`:784-857`); bei 102 Karten
  unkritisch, bei 295 und mehr langsam.
- Import gibt jeden empfangenen Proof einzeln neu aus, ein Tausch je Proof, Abbruch
  beim ersten Fehler (`:749-767`).
- Kosmetik: Fehlertext nennt weiterhin "600B-E1", `catalogUri` ist für
  `UNIT === "600B-E1"` sonderbehandelt.

## 7. Übernahme bei uns

Vorläufig; die Reihenfolge wird nach der Prüfung von LNURLcash-Assets und dem
Blossom-Stand festgelegt (siehe Abschnitt 8).

| Nr. | Übernahme                                                                                                        | Ziel                                                                                | Aufwand und Risiko                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Katalog als hashadressierter Blob auf echten Blossom-Servern, `catalog_uri` mit Hash, `/v1/info` bewirbt sie     | `TCG600nap/server/nutft-mint.js` (Katalog, Info), Upload-Skripte                    | mittel; Identitätstripel der Mint ändert sich, deshalb nur für neue Editionen |
| 2   | Wallet-Bibliothek generisch: Einheit aus `/v1/keys`, Katalogadresse aus `/v1/info`, Speicherschlüssel je Einheit | `TCG600nap/site/nutft-wallet.js:109` und Aufrufer; später `nutft-vault` in Bearlett | klein bis mittel; Tests vorhanden                                             |
| 3   | `encodeToken`-Fix für große Token                                                                                | `TCG600nap/site/nutft-wallet.js`                                                    | klein                                                                         |
| 4   | NUT-09 und NUT-13                                                                                                | PR 29 im TCG-Repository prüfen und mergen                                           | Review-Entscheidung des Auftraggebers                                         |
| 5   | Zweiphasiger Kauf ohne Vorab-Anzeige der Karten                                                                  | `server/nutft-mint.js` Angebot und Booster-Pfad                                     | mittel bis hoch; berührt beacon-versiegelte Packs, Idempotenz und Bezahlung   |
| 6   | Besitznachweis je Proof                                                                                          | `server/nutft-mint.js`, Wallet, später `card/provenance` in Bearlett                | mittel                                                                        |
| 7   | Gebündelte Abhängigkeiten statt esm.sh                                                                           | `site/wallet.html`                                                                  | klein                                                                         |
| 8   | Spiel als Napplet mit Shell-Signer                                                                               | eigenes Vorhaben, nicht Teil dieser Übernahme                                       | groß                                                                          |

Nicht übernommen: unbegrenzte Auflage, CSPRNG ohne Beacon, Blobs nur auf der Mint,
umgehostete Fremdrechte.

## 8. Umgesetzt am 10. September 2026

Branch `feature/nutft-catalog-blob` in `TCG600nap`, aufgesetzt auf
`feature/g-mint-live`; 434 Tests grün, 431 bestehende und 3 neue.

- **Übernahme 1**, in der Form, die bestehende Editionen erlaubt: Die Mint
  signiert den Katalog deterministisch (BIP-340 mit Null-Aux), friert die Bytes
  beim Start ein, liefert sie unter `/nutft/catalog` und `/blossom/<sha256>` aus
  und bewirbt in `/v1/info` die Felder `catalog_uri`, `catalog_blob_sha256` und
  `catalog_blob_urls`; Spiegel kommen aus `NUTFT_CATALOG_MIRRORS`, für G aus
  `G_NUTFT_CATALOG_MIRRORS`. Die Katalogadresse bleibt die Identität, der Blob ist
  der Transport. Für neue Editionen darf `catalog_uri` selbst eine Blossom-Adresse
  sein.
- **Übernahme 2**: `site/nutft-wallet.js` akzeptiert jedes NutFT-Keyset, also eine
  Einheit mit dem einzigen Betrag 1, wahlweise eingeschränkt über `NUTFT_UNITS`;
  `NUTFT_STORE` ist wählbar. Die Wallet holt den Katalog zuerst per Hash von der
  Mint, dann von den Spiegeln, prüft die Bytes gegen den Hash und fällt erst dann
  auf die Katalogadresse zurück.
- **Übernahme 3**: `encodeToken` für Token über 32 KiB. Der Fehler in cashu-ts
  4.7.2 wurde am Paket verifiziert: Base64 in Blöcken zu 32.768 Bytes
  (`lib/cashu-ts.es.js:184-192`); 4.10.1 hat die Blockbildung nicht mehr.
- Neu: `scripts/blossom-auth.mjs` (BUD-11, base64url ohne Padding) und
  `scripts/upload-catalog.mjs` (BUD-02-Upload des Katalog-Blobs, Prüfung je
  Spiegel, verlangt mindestens zwei); README-Abschnitt "Content-addressed
  publishing" erweitert.
- Tests: `tests/js/nutft-catalog-blob.test.mjs` (Blob-Route, Determinismus über
  einen Neustart, Wallet-Pfad mit manipuliertem Blob und Rückfall, fremde Einheit,
  Allowlist, Token über 32 KiB) und `tests/js/helpers/browser-wallet.mjs`.

Nicht umgesetzt: zweiphasiger Kauf und Decks (4, 5), Besitznachweis (6),
Bündelung der Abhängigkeiten (7). PR 29 (NUT-09 und NUT-13) kollidiert in fünf
Dateien mit dem Live-Branch und bleibt eine Merge-Entscheidung des Auftraggebers.

## 9. Prüfungen: LNURLcash und Blossom

### 9.1 Karten über LNURLcash statt Cashu

Ergebnis: **nein**, nicht ohne eigene Protokollerweiterung. Befund vom 10. September 2026 gegen `lnurlcash/lnurl-wallet` (`6088135`, v0.10.7) und
`lnurlcash/lnurl-mint` (`bd21f61`, v0.6.1):

- "Asset" heißt bei dni der Bearer-Schein selbst, fungible Millisats; LUD-25 trägt
  den Titel "Bearer assets". Kein Feld für Asset-ID, Einheit, Metadaten, Bild oder
  Einmaligkeit im Datenmodell (`lnurl_mint/db.py:56-62`, `src/storage.ts:27-58`).
- Die neuesten Funktionen sind Note-Tags (#116) und Addons (#117, Alpha): lokale
  Labels und Manifeste, nichts davon auf der Leitung.
- Unsere frühere Asset-Schicht (`lnurlcash/lnurl-mint#1`, NORD) wurde am 8. August 2026 ungemergt geschlossen; nichts davon liegt auf `main`.
- LUD-25 (`lnurl/luds`, Branch `lnurlcash`, `ff65c09b` vom 10. September 2026,
  Teil 2 neu geschrieben): `cs1` signiert Betrag und Schlüssel, keine Asset-Felder.
- Gegenüber NutFT fehlen Bindungshash, Empfängersperre (P2BK), DLEQ und blinde
  Signaturen; der Dienst sieht jede Rotation; Split und Merge sind immer erlaubt.

Konsequenz: LNURLcash bleibt die Schiene für Sats in _Pay_; Karten bleiben
Cashu-NutFT.

### 9.2 Assets auf Blossom nach hzrd149

Stand `hzrd149/blossom` `b5bd280` (15. Juni 2026), alle BUDs Entwurf: BUD-01
GET und HEAD, BUD-02 Upload, BUD-03 Serverliste Kind 10063, BUD-04 `PUT /mirror`,
BUD-10 `blossom:`-URI (seit November 2025), BUD-11 Auth Kind 24242 mit base64url,
BUD-12 Liste und Löschen. Server `hzrd149/blossom-server` 6.3.0 (Deno 2, MIT,
Regeln je Pubkey und MIME, Spiegelung, kein BUD-07); lokaler Klon
`G:\Github\blossom-server` auf `1730b08`. `blossom.bimcvp.com` nimmt
`application/json` an; ob `blossom.primal.net` und `nostr.download` JSON annehmen,
ist nicht verifiziert. Umgesetzt siehe Abschnitt 8. Offen: Spiegelung per BUD-04
statt Mehrfach-Upload in `upload-blobs.mjs`, Kind 10063 für den Aussteller,
`check_blobs.py` mit mindestens zwei Servern je Hash, Katalog-Blob live
veröffentlichen und die Spiegel in `NUTFT_CATALOG_MIRRORS` eintragen.

## 10. Quellen

Seite und Endpunkte: `/v1/info`, `/v1/keys`, `/nutft/catalog`, `/nutft/state`,
`/nutft/quote`, `/nutft-wallet.js`, `/pokemon/app.js`, `/pokemon/host.js`,
`/pokemon/sw.js`, `/pokemon/runtime.html`, `/pokemon/engine.mjs`.
<https://github.com/brenorb/NutFT>,
<https://github.com/BIMbeamFLX/600BillionTimelockTCG/pull/29>,
<https://github.com/keeshii/ryuu-play>, <https://tcgdex.dev/faq>,
<https://dev.pokemontcg.io/terms>. Lokal: `TCG600nap/server/nutft-mint.js`,
`site/nutft-wallet.js`, `site/wallet.html`, `docs/adr/0001` bis `0004`,
`docs/deploy-runbook-mint.md`.
LNURLcash: <https://github.com/lnurlcash/lnurl-wallet>,
<https://github.com/lnurlcash/lnurl-mint>, <https://github.com/lnurlcash/lnurl-mint/pull/1>,
<https://github.com/lnurl/luds/blob/lnurlcash/25.md>. Blossom:
<https://github.com/hzrd149/blossom>, <https://github.com/hzrd149/blossom-server>,
<https://github.com/hzrd149/blossom-client-sdk>,
<https://github.com/nostr-protocol/nips/blob/master/B7.md>. cashu-ts 4.7.2:
`lib/cashu-ts.es.js` aus dem npm-Tarball.

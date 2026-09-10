# Infrastruktur: was noch gebaut werden muss

Stand: 10. September 2026. Ergänzung zu
[INFRASTRUCTURE-2026-09-09.md](INFRASTRUCTURE-2026-09-09.md) (Inventar und
Testplan) und [UI-DESIGN-2026-09-09.md](UI-DESIGN-2026-09-09.md) (zwölf composable
Napplets). Dieses Dokument listet nur, was fehlt, und ordnet es. Nichts davon ist
gebaut oder bestellt.

## Grundsatz: bestehende Mints nutzen

Bearlett betreibt keine eigene Mint für Sats. Drei Klassen von Ausstellern, alle
vorhanden oder von Dritten betrieben:

| Asset             | Aussteller                                                                                                                                                                                 | Vorhanden                                      | Zu tun                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cashu-Sats        | Bestehende Nutshell-Mints. Regtest: `cashubtc/nutshell:0.20.3` an LND Bob, Host-Port 43338. Produktion: öffentliche Mints nach Kriterien wählen                                            | Regtest ja, Auswahl produktiver Mints nein     | Kriterienliste anwenden: NUT-07, NUT-08, NUT-09, NUT-13, NUT-20, Gebührenpolitik, Erreichbarkeit, BOLT12-Signal; mindestens zwei Mints je Einheit für Ausfall |
| LNURLcash-Scheine | Bestehende LNURLmint-Instanzen (dnis `lnurl-mint`). Regtest: Image `bearlett-regtest-lnurl:latest`, Quelle `bd21f61`, an LND Alice, Host-Port 48111                                        | Regtest ja, produktiver Dienst nicht ermittelt | Öffentliche LNURLcash-Dienste ermitteln und gegen LUD-25 prüfen; kein eigener Betrieb in V1                                                                   |
| NutFT-Karten      | First-Party-Mint der TCG-Wallet (`TCG600nap/server/nutft-mint.js`). Sie ist laut [TCG-WALLET-2026-09-09.md](TCG-WALLET-2026-09-09.md) vorgeschrieben und nicht durch Dritt-Mints ersetzbar | Code ja, Betrieb siehe Abschnitt F             | Hosting, Lightning-Backend, Katalog und Artwork; Anleitung in [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md)                                                  |

Alles, was eine Mint braucht, um Bearlett zu bedienen, ist ein HTTPS-Endpunkt mit
den genannten NUTs und korrekten CORS-Headern. Beide Regtest-Mints beantworten
OPTIONS-Requests mit `Access-Control-Allow-Origin: *`; das belegt den Preflight,
nicht den vollen Browserfluss.

## Was vorhanden ist

Aus dem Inventar vom 9. September, unverändert:

- Regtest-Stapel unter WSL Ubuntu mit Docker Engine 29.3.0: Bitcoin, LND Alice und
  Bob `v0.19.3-beta` mit finanziertem Kanal, Nutshell, LNURLmint;
  `tests/integration/compose.yaml`, `scripts/regtest.mjs`, `npm run test:regtest`.
  Leerlauf etwa 341 MiB RAM, Images zusammen etwa 2,2 GB.
- Echter Kehto als gepatchter alter Checkout `14a14155`; Pakettests bestanden.
- Lokale Fremddienste aus `terrcvm-corpus`: strfry auf 7777, Blossom auf 3000 und
  8787, einer davon unhealthy; nicht Teil von Bearlett.
- Blossom-Spiegel für Kartenbilder: `blossom.primal.net`, `blossom.bimcvp.com`,
  `nostr.download`. Verschlüsselte TCG-Backups laufen heute über
  `blossom.bimcvp.com` und `wss://relay.bimcvp.com` (Kind 37378).
- Entwicklungs-Host `scripts/napplet-host.mjs` mit Test-Mint im Speicher; kein
  Produktionshost.

Fehlend nach der Kopie nach `G:`: der Checkout `work/lnurl-mint` und die
Docker-Volumes des früheren Standorts. Vor jedem Regtest wiederherstellen, wie in
INFRASTRUCTURE-2026-09-09 beschrieben.

## Was gebaut werden muss

Reihenfolge nach Abhängigkeit. Ohne A läuft kein Napplet außerhalb der Vorschau.

### A. Shell und Host-Fähigkeiten

1. Produktive Shell mit den NAP-Domänen `storage`, `resource`, `inc`, `intent`.
   Kandidaten: Kehto (Checkout vorhanden) oder der Nappelin-Hangar (betreibt heute
   nur ein Speicher-Relay, siehe
   [NAPPELIN-INTEGRATION-2026-09-09.md](NAPPELIN-INTEGRATION-2026-09-09.md)).
2. Die experimentelle `cashu`-Host-Fähigkeit mit Writer-Lease je Speicherbereich
   nach [KEHTO.md](KEHTO.md). Ohne sie bleibt nur LNURLcash.
3. Resource-Policy: Allowlist für Mints, LNURLcash-Dienste und Blossom-Spiegel,
   nur HTTPS, 3-MB-Grenze für Kartenbilder, keine Bearer-URLs in Logs.
4. Kaltstart-Zustellung von Intents, Standard-Handler je Archetyp, ein Fenster je
   Speicherbereich. Nachweis für Anfrage und Antwort über zwei Intents, wie in
   UI-DESIGN Abschnitt 6 beschrieben.
5. Persistenter Host-Store mit Quota- und I/O-Fehlerinjektion für Tests.

### B. Identität und Signer

1. Wiederherstellbare Nappelin-Identität als Zugang; Gast nur temporär.
2. NIP-44 im Worker oder über externen Signer (NIP-07 im Web, NIP-46 oder NIP-55
   auf Android). Kein privater Schlüssel im iframe.
3. Kompatibilitätsadapter zwischen bestehendem TCG-Backup und dem
   Hangar-Vertrag; Figur-/Stein-Provisionierung und Wiederherstellung auf einem
   zweiten Gerät nachweisen.

### C. Backup-Transport

1. Persistenter Nostr-Relay für signierte Backup-Referenzen. Ein isolierter,
   geprüfter Bearlett-Relay fehlt; vorgesehen ist strfry auf Loopback 47777 mit
   eigener Datenbank, Vorschlag noch nicht gebaut. Die 500-Event-Grenze der
   TCG-Sync-Historie ist zu beheben oder zu umgehen.
2. Verschlüsselte Snapshots auf Blossom: zwei unabhängige Speicher plus
   Dateibackup, Upload-Autorisierung über den Signer, Rücklesen und Hashprüfung vor
   Veröffentlichung der Referenz. Aufbewahrung und Quoten der Spiegel prüfen.
3. Expliziter Gerätewechsel mit einem Schreiber; kein Relay liefert einen Lock.

### D. Medien

1. Spiegelung der Kartenbilder auf mindestens zwei Blossom-Servern sichern, die
   nicht vom selben Betreiber abhängen. Heute sind drei Spiegel konfiguriert,
   Spiegelung selbst ist in der TCG-Wallet nicht implementiert.
2. Bildcache im Napplet über den Storage-NAP, mit Quotenverhalten nach Neustart.

### E. Lightning und BOLT12

1. cashu-ts 4.10.1 kann BOLT12-Mint- und Melt-Quotes; der Mint muss sie anbieten
   und Angebote mit Beschreibung signalisieren. Welche bestehenden Mints das tun,
   ist zu ermitteln.
2. Der Regtest hängt an LND. LND bietet BOLT12-Angebote bis `v0.21.0-beta`
   (Juni 2026) nicht nativ; `v0.21` leitet Onion-Nachrichten weiter, Angebote
   liefert nur der Sidecar LNDK. Core Lightning, LDK und Eclair können BOLT12
   nativ. Für BOLT12-Tests braucht der Stapel einen CLN-Knoten im Compose und
   eine Mint, die Angebote anbietet. Belegt ist das für die Rust-Mint des Cashu
   Development Kit ab `v0.12.0`: BOLT12 Ende zu Ende, wahlweise mit CLN-Backend
   oder mit `cdk-ldk-node`, das Mint und Lightning-Knoten in einem Binary
   betreibt. Für Nutshell 0.20.3 wurde keine BOLT12-Unterstützung gefunden.
   Konsequenz: Für BOLT12 im Regtest eine CDK-Mint neben Nutshell aufnehmen,
   für die Produktion bestehende CDK-Mints mit BOLT12-Signal wählen. Quellen:
   <https://www.spark.money/research/lightning-network-2026-state>,
   <https://www.nobsbitcoin.com/lndk/>, <https://github.com/cashubtc/cdk/releases>,
   <https://blog.cashu.space/cashu-highlights-q3-25/>.
3. LNURLcash kennt kein BOLT12. BOLT12-Zahlungen aus LNURLcash-Guthaben laufen über
   die vorhandene Lightning-Brücke zu einem Cashu-Mint; keine neue Infrastruktur,
   aber ein zusätzlicher Regtest-Pfad.

### F. NutFT-Mint für Karten

Befund aus `TCG600nap` `d753505`, Details in [HOW-TO-MINT-ASSETS.md](HOW-TO-MINT-ASSETS.md);
Vergleich mit Brenos Pokémon-Mint in
[NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md):

- Ein Node-Prozess `server/table.js` (`npm run table`), Port `PORT` mit Standard
  8777, reines HTTP. TLS kommt vom Reverse-Proxy: Caddy auf Loopback mit
  `TRUST_PROXY=loopback`, systemd-Unit `tcg-table.service` laut
  `docs/deploy-runbook-mint.md`. Die Mint ist eine Bibliothek in diesem Server,
  kein eigener Prozess.
- Zwei Instanzen: Edition One unter den Basispfaden, G unter `/g` mit eigener
  SQLite-Datei (`G_NUTFT_DB`, `G_NUTFT_FUNDING` verpflichtend).
- Lightning-Backends in `server/funding.js`: `lnd` über REST mit
  Invoice-Macaroon, `phoenixd` (zahlt auch aus), `cashu` (custodial, nur
  Staging), `mock` (nur mit `NUTFT_ALLOW_VIRTUAL=1`), `none` als Gratis-Demo.
  Booster werden per BOLT11 bezahlt; BOLT12-Verkauf wäre Neubau.
- Identität: `mint_seed` und `catalog_private_key` entstehen beim ersten Start in
  der SQLite-Tabelle `nutft_meta`. Es gibt keine Schlüsseldatei. Das
  Datenbank-Backup ist das Backup der Mint-Identität.
- Katalog: `NUTFT_CATALOG_URI` zeigt auf `GET /nutft/catalog` der eigenen Mint;
  das Tripel aus `census_sha256`, `collection_id` und `catalog_uri` wird
  eingefroren, jede Abweichung verweigert den Start.
- Live heute: Runbook Pfad A als Gratis-Demo auf `tcg.nappelin.com`. Im Code steht
  keine Mint-URL; `site/shop.js:96` leitet sie aus `location.origin` ab.

Zu bauen oder zu betreiben:

1. Server mit Domain, Caddy und systemd; verschlüsseltes, getrenntes Backup der
   SQLite-Datei vor der ersten Ausgabe.
2. Lightning-Backend: phoenixd oder LND mit Invoice-Macaroon; Backend-Zugang nur
   vom Mint-Host. Beacon-Quelle für Ziehungen (`NUTFT_BEACON_SOURCE`,
   `NUTFT_BEACON_CONFIRMATIONS`) bei Booster-Editionen; Manifest-Editionen wie G
   brauchen keinen Beacon.
3. Blossom-Uploads der Kartenbilder mit einem Nostr-Schlüssel
   (`scripts/upload-blobs.mjs`, BUD-02, Kind 24242, `PALACE_NSEC`) auf die drei
   Spiegel; Vorhandensein mit `scripts/check_blobs.py` prüfen.
4. Backup-Relay mit Wallet-Allowlist (`TCG_WALLET_BACKUP_ALLOWLIST`,
   `server/relay-policy-patch.js`, `server/relay-wallet-allowlist.js`).
5. Für die Bearlett-Assets-Napplets: Mint-URL und Spiegel über die
   Resource-Policy, nicht im Code. Die feste Einheitenliste in
   `site/nutft-wallet.js` ist auf `feature/nutft-catalog-blob` entfernt, und die
   Mint liefert den Katalog dort als hashadressierten Blob mit
   `NUTFT_CATALOG_MIRRORS`; siehe
   [NUTFT-POKEMON-POC-2026-09-10.md](NUTFT-POKEMON-POC-2026-09-10.md), Abschnitt 8.
   Offen: Katalog-Blob live veröffentlichen und Spiegel eintragen.
6. Härtung: `NUTFT_REQUIRE_PRODUCTION_KEYS` ist nur dokumentiert, nicht
   implementiert; Verkaufsmodus `NUTFT_SALES`, Preisleiter
   `NUTFT_PRICE_SCHEDULE`, Rechnungs-TTL und Claim-Frist bewusst setzen.

### G. Test- und Nachweisumgebung

1. Crash-Matrix aus INFRASTRUCTURE-2026-09-09 automatisieren: Stopp nach benanntem
   Journal-Checkpoint, Neustart mit erhaltenem Store, für beide Transferrichtungen.
2. Host- und Browsertests mit verifizierten Artefakten, eigenen Browserprofilen,
   NIP-07- oder NIP-46-Testsigner mit synthetischer Identität, Upgrade des
   Artefakthashes und Intent-Kaltstart.
3. Android nach Capacitor: Android Studio ab 2025.2.1, JDK, SDK 36, API-36-Emulator
   und ein echtes NFC-fähiges Gerät für NIP-55, Kamera, NFC und Keystore. Nicht
   eingerichtet. `adb reverse` für 43338, 48111, 47777; lokale, auf dem Gerät
   vertrauenswürdige HTTPS/WSS-Terminierung und auflösbare Mint-Hostnamen.
4. Messung eines gebauten Napplets mit Three.js auf einem mittleren Android-Gerät.

### H. Verteilung und Betrieb

1. Signierte NIP-5D-Manifeste (Kind 35129) und ein Installationsweg über die Shell.
   Blossom oder nsite erst bei Installation und Verteilung, nicht für den Regtest.
2. TLS-Terminierung und DNS für alle selbst betriebenen Dienste: NutFT-Mint,
   Backup-Relay, Blossom-Spiegel. Keine Zertifikatsprüfung im Produkt abschalten.
3. GitHub Actions bleiben aus, bis der Auftraggeber sie freigibt; die frühere
   Freigabeprüfung hat das Aktivieren ohne Rückfrage abgelehnt.

## Was ausdrücklich nicht gebaut wird

- Keine eigene Sats-Mint, weder Cashu noch LNURLcash.
- Kein Marktplatz, keine Preise, keine HTLC-Swaps: Granola bleibt V2.
- Kein Compare-and-swap-Relay für Cashu-Sync; für V1 nicht erforderlich.
- Hashtree und Envelope sind optionale Zusätze, keine Voraussetzung für
  verschlüsselte Backups.

## Budget und Reihenfolge

Planungsbudget aus dem Inventar, ausdrücklich Schätzung: 4 GB RAM für Builds und
Mints, 8 bis 16 GB mit Android-Emulator, 10 bis 30 GB Plattenplatz für SDK, AVD und
Images, 256 MiB für einen kleinen Relay. Kein VPS und keine echten Sats für lokale
Tests. Für den Betrieb der NutFT-Mint, eines Relays und eines Blossom-Spiegels
kommt ein Server mit TLS hinzu; Größe nach Abschnitt F.

Empfohlene Reihenfolge: A, dann B und C parallel, dann E und F, dann G, zuletzt H
und Android.

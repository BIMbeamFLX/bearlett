# Bearlett: Machbarkeits- und Spec-Check

Prüfdatum: 9. September 2026. Ausgangspunkt: `87fd4f0` auf
`feature/bearlett`. STARTPROMPT.md und die darin genannten Projektdokumente
wurden vollständig gelesen. Die bestehenden Änderungen an README.md und
package.json sowie STARTPROMPT.md bleiben erhalten. Keine Wallet-Neuimplementierung,
kein Push, keine Veröffentlichung, keine Änderung an Actions oder fremden
Docker-Projekten. Ausschließlich Testcoins und synthetische Testschlüssel.

## Urteil

**Das Produkt ist technisch machbar; der vorhandene Stand ist eine brauchbare
experimentelle Basis, aber noch keine belastbar sichere Wallet.** Beide Protokolle
und die Lightning-Brücke funktionieren im reproduzierten Regtest. Fünf zusätzliche
Reproduktionen zeigen jedoch Lücken an der Speicher-/Recovery-Grenze. Diese müssen
vor neuen Plattformen behoben werden. Insbesondere bedeutet ein erfülltes
`storage.setItem()` im aktuellen Kehto-/Shim-Paar nicht zuverlässig, dass der
Schreibvorgang erfolgreich war.

Empfehlung: gemeinsamer TypeScript-Transaktionskern, explizite Speicher-,
Transport-, Signer- und Lifecycle-Adapter; Web/PWA zuerst, Android über einen
begrenzten Capacitor/Kotlin-Spike. Für standardnahe Napplets gehört der
schlüsselhaltende Wallet-Dienst in den vertrauenswürdigen Host. Notes bleibt ein
unabhängiger Designer. Details und Abnahmekriterien stehen in
[ARCHITECTURE-2026-09-09.md](ARCHITECTURE-2026-09-09.md).

**Bestätigte Produktentscheidung:** Ein aktiv schreibendes Gerät mit ausdrücklichem
Gerätewechsel genügt für V1. Ein eigener CAS-Relay ist daher keine V1-Voraussetzung.
Die Entscheidung wurde zuerst in der lokalen SQLite-Prüfakte festgehalten.

Während der Prüfung zusätzlich gewünschte Richtung: XMR-/USDT-Swaps über
Mints mit Granola. Das ist als gesonderte, noch unbelegte Erweiterung in der
Architektur erfasst. Granolas heutige Testnut-SAT/USD-Swaps sind weder native
XMR-/USDT-Swaps noch eine fertige Anbindung in dnis LNURLwallet.

## Funktions-/Plattformmatrix

„Belegt“ gilt jeweils nur für die angegebene Testgrenze. „Experimentell“ bedeutet
vorhandene Implementierung mit offenen Integrations- oder Sicherheitsfragen;
„fehlend“ bedeutet keine entsprechende Bearlett-Implementierung.

| Funktion                                              | Napplets heute                                                                                            | Web/PWA heute                                                          | Android heute                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Grafische LNURLcash-/Cashu-Sammlung                   | Belegt im Preview, experimentell im echten Host                                                           | Original-Webwallet nur LNURLcash; gemeinsame Bearlett-Oberfläche fehlt | App fehlt                                     |
| Getrennte Notes-App, Bildupload, Designübergabe       | Belegt: zwei Builds, getrennte Tabs, Review, keine Protokoll-Secrets im Vertrag                           | Code wiederverwendbar; eigener Bearlett-Webflow fehlt                  | Machbar, noch nicht integriert                |
| LNURLcash Empfang, Rotation, Split, Merge, Weitergabe | Unit-/Browserbelege; Mint/Transfer im Regtest. RESOURCE-Mutationen sind eine semantische Host-Erweiterung | Original vorhanden und Build grün; Hardware nicht real geprüft         | Kern wiederverwendbar; Adapter fehlen         |
| Cashu A/B, ungebundene sats, Empfang mit Rotation     | Crypto-Fixtures und Browser belegt, echte Mint-/Melt-Operationen im Regtest                               | Engine vorhanden, Webintegration fehlt                                 | Engine wiederverwendbar; App fehlt            |
| Lightning mint/melt und Protokollwechsel              | Beide Richtungen im Regtest belegt; Fehlerpfade experimentell                                             | Noch keine entsprechende Bearlett-Webversion                           | Fehlt                                         |
| Lokale verschlüsselte Backups                         | Vorhanden, aber F00–F04 verhindern Freigabe                                                               | Legacy-Backup vorhanden; gemeinsames Backup fehlt                      | Sicherer Speicher und Restore fehlen          |
| Phrase-Recovery                                       | Vorhanden, unvollständige Counter-Suche F04; Mint-Liste separat nötig                                     | LNURLcash vorhanden; Cashu nicht integriert                            | Fehlt                                         |
| Wallet-Nostr-Key, Relay-Backup                        | Fehlen; IDENTITY/RELAY allein reichen nicht                                                               | NIP-07/NIP-46 technisch verfügbar, Integration fehlt                   | NIP-55 technisch verfügbar, Integration fehlt |
| Gerätewechsel                                         | Fehlt; lokaler Host-Lease ist kein Geräte-Lock                                                            | Fehlt                                                                  | Fehlt                                         |
| Kamera                                                | Kein allgemeiner Kamera-NAP im geprüften Vertrag                                                          | Originalscanner vorhanden; echte Kamera ungeprüft                      | Native Kamera möglich, Gerätetest fehlt       |
| NFC                                                   | Unter `allow-scripts` nicht als Web-NFC nutzbar                                                           | Original vorhanden; Web-NFC ist browser-/geräteabhängig                | Native NFC-Anbindung möglich, ungeprüft       |
| USB/BLE-Gerätevault                                   | Adapter und simulierte Tests vorhanden                                                                    | Originalfunktionen vorhanden                                           | Portierung und echte Geräteprüfung fehlen     |
| HTLC/P2PK, USD, Börsen-/Atomic-Swaps                  | Nicht V1                                                                                                  | Nicht V1                                                               | Nicht V1                                      |

## Reproduzierte Prüfungen

Ausgeführt mit Node **24.15.0**, npm **11.12.1**, Git **2.53.0.windows.1**.
package.json nennt npm 12.0.2; das ist hier keine tatsächlich verwendete Version.
Bestehende Bearlett-node_modules wurden verwendet; kein frisches `npm ci` für den
Hauptcheckout. Drittprojekte wurden getrennt aus ihren Lockfiles installiert.

| Prüfung                                             | Ergebnis dieser Session                                                                                         | Lokales Rohprotokoll                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm test`                                          | 353 bestanden, 1 opt-in Integrationstest übersprungen                                                           | `unit.log`                                             |
| `npm run tsc`                                       | Bestanden                                                                                                       | `tsc.log`                                              |
| Original-Webwallet, Wallet, Notes Build             | Alle bestanden; finale HTMLs 418.712 / 34.631 Bytes für Wallet/Notes                                            | `build-web.log`, `build-wallet.log`, `build-notes.log` |
| `npm run test:napplet:browser`                      | 12 bestanden; Windows-Preview-Prozess musste nach Testende beendet werden, Gesamtlauf 8,3 Minuten               | `browser.log`                                          |
| `npm run format:check`                              | Fehlgeschlagen: 139 Dateien                                                                                     | `format.log`                                           |
| Prettier mit `--end-of-line auto`                   | Nur STARTPROMPT.md verbleibt; überwiegend CRLF/LF, keine pauschale Umformatierung vorgenommen                   | `format-auto-eol.log`                                  |
| `npm audit --json`                                  | 0 gemeldete Schwachstellen; kein Sicherheitsbeweis                                                              | `npm-audit.json`                                       |
| Echter bidirektionaler Regtest                      | 1 Test bestanden, 5,58 s; verlorene Melt-Antwort, Restore, Wechselgeld, nur ein Melt                            | `regtest.log`                                          |
| Zusätzliche isolierte Fehlerreproduktionen          | 5 beobachtete Fehlverhalten bestätigt; **keine** grünen Sicherheits-Abnahmetests                                | `reproductions.log`                                    |
| Gepatchtes Kehto: betroffene Pakete + Paja-Devtools | 1.103 Tests in 65 Dateien bestanden                                                                             | `kehto-tests.log`                                      |
| Gesamtes gepatchtes Kehto                           | 1.757 bestanden, 9 Testfehler; 9 fehlgeschlagene Dateien einschließlich 4 Ladefehler                            | `kehto-full-tests.log`                                 |
| Cashu Sync: `src/sync` und `src/v0`                 | 222 Tests in 19 Dateien bestanden                                                                               | `cashu-sync-tests.log`                                 |
| Cashu Sync: Go-Relay                                | Alle vier Testpakete bestanden; zwei Command-Pakete ohne Tests                                                  | `cashu-sync-relay-tests.log`                           |
| Granola                                             | 442 bestanden, 7 übersprungen, 52 Dateien                                                                       | `granola-tests.log`                                    |
| Envelope                                            | 36 lokale Tests bestanden                                                                                       | `envelope-tests.log`                                   |
| Napplets Workshop                                   | Typecheck/Build bestanden; Conformance: 8 bestanden, 1 Warnungsfehler, 2 übersprungen, CLI urteilt „CONFORMANT“ | `workshop-verify.log`, `workshop-conformance.log`      |

Rohprotokolle, Quellenstände und SQLite liegen unter
`outputs/feasibility-2026-09-09/` und werden gemäß .gitignore nicht versioniert.
Der [Evidenzindex](checks/evidence-2026-09-09.json) enthält SHA-256-Prüfsummen
der lokalen Artefakte und einen Export der zuvor in SQLite erfassten Entscheidungen.
Die Reproduktionen unter [checks/](checks/) sind versionierbar und ohne Docker
oder Netzwerk ausführbar. Sie behaupten absichtlich das beobachtete Fehlverhalten;
nach einer Korrektur müssen daraus Tests der gewünschten Invarianten werden.

Der Regtest benutzt echte Bitcoin-/LND-/Mint-Implementierungen, aber einen
In-Memory-Walletspeicher und einen direkten Node-Transport mit zwei fest
abgebildeten HTTPS-Testidentitäten. Er beweist weder dauerhafte Browserablage
noch TLS, Android, Signer oder den produktiven Kehto-Permissionflow.

Die Kehto-Gesamtfehler betreffen unter anderem CRLF-/Pfad-sensitive Assertions,
Paket-/Lockfile-Abgleich, drei Script-Lader und den ungebauten Paja-CLI-Export.
Die ursprüngliche Aussage „gesamtes Kehto nicht grün“ bleibt damit richtig.

## Priorisierte Befunde

### F00 — P1: Falsche Erfolgsbestätigung bei Host-Speicherfehlern

Kehtos `packages/shell/src/hooks-adapter.ts:220` fängt Speicherfehler ab und gibt
bei `set` false zurück; fehlgeschlagene Reads können als null/leere Liste erscheinen.
`packages/runtime/src/state-handler.ts:208` antwortet auf den Write mit
`{ok: success}`. Der installierte Shim 0.28.0 lehnt ausschließlich Antworten mit
`error` ab und ignoriert `ok:false`.

Der fünfte Reproduktionstest führt den **tatsächlich installierten offiziellen
Prelude-Code** in einer isolierten VM aus: `setItem()` erfüllt sich auf eine
korrelierte `storage.set.result`-Antwort mit `ok:false`. Damit kann die Wallet
nach einem nicht gespeicherten Journal weiterarbeiten. Die Tests des lokalen
Vaults benutzen einen Storage-Adapter, der Fehler korrekt wirft, und entdecken
diesen Integrationsfehler daher nicht.

Abhilfe: Host muss fehlgeschlagene Reads/Writes als Fehler transportieren; Shim
muss negative ACKs ablehnen. Anschließend QuotaExceeded-/I/O-Fehler vom echten
Storage bis zur verbotenen Mint-Mutation testen. Ein Read-back alleine wäre
keine Transaktions- oder Stromausfallgarantie.

### F01 — P1: Fehlendes Wechselgeld kann einen Melt abschließen

In `src/napplet/cashu/engine.ts:493` verarbeitet `resume()` einen PAID-Quote und
setzt `quote.change ?? []` ein. `finish()` markiert Inputs danach spent und den
Vorgang complete. Die Reproduktion bezahlt 10 aus 32 Testsats, die Fixture stellt
21 Sats Wechselgeld aus; die Quote-Antwort lässt `change` weg. Ergebnis: complete,
kein verfügbares Guthaben, kein NUT-09-Fallback. Der Payment-Preimage ist korrekt.

Abhilfe: Quote-ID, Invoice, Einheit, Betrag und Gebühren an das Journal binden;
Mindestwechselgeld `reservedAmount - maximumDebit` durchsetzen; vorhandene
Blank-Outputs restaurieren und deren Zustand prüfen. Fehlt erforderliches
Wechselgeld, bleibt die Zahlung in Abklärung. Der unmittelbar erfolgreiche
`pay()`-Pfad braucht dieselbe Wertbilanz, nicht nur der Resume-Pfad.

### F02 — P1: Backup authentifiziert einzelne Records, nicht Vollständigkeit

`src/napplet/vault.ts:247` exportiert einen unversiegelten Container verschlüsselter
Records; `restore()` prüft nur die tatsächlich enthaltenen Records. Entfernen
von `metadata['cashu-v1']` aus einem gültigen Backup wird akzeptiert und ergibt
in der Reproduktion einen scheinbar erfolgreichen Import ohne Cashu-Guthaben.
Auch das Mischen älterer gültiger Records ist damit nicht grundsätzlich erkannt.

Abhilfe: gesamtes Backup mit Version, Wallet-ID, Revision, vollständigem
Record-Verzeichnis, Countern und Journal-Referenzen authentifizieren; keine
Auslassung als „Legacy“ interpretieren. Echte Legacy-Formate ausdrücklich getrennt
importieren. Eine gültige Signatur eines alten Komplettsnapshots beweist trotzdem
keine Aktualität.

### F03 — P1: Seed-Zuordnung beim Vollimport unvollständig

`src/napplet/vault.ts:410` vergleicht Cashu-Seeds nur, wenn die Zielwallet bereits
`cashu-v1` besitzt. Eine neue LNURLcash-Wallet mit **anderer** Phrase und noch
deaktiviertem Cashu importiert deshalb ein fremdes Cashu-Backup. Ihre aktuelle
Phrase und der danach gespeicherte Cashu-Seed passen nicht zusammen; der fremde
LNURLcash-Root landet separat in `cash-imports`.

Abhilfe: Vollrestore muss die Identität aller Protokollwurzeln vor dem ersten
Write beweisen bzw. die gesamte Wallet ausdrücklich wiederherstellen. „Assets
aus fremder Wallet importieren“ braucht einen getrennten Migrationsflow, keine
stillschweigende Phrase-Behauptung.

### F04 — P1: Seed-Recovery stoppt zu früh und gibt Mint wieder frei

`src/napplet/cashu/engine.ts:687` beendet die Suche nach **einer** leeren
100er-Range und setzt den Mint auf scanned. Die aktuelle NUT-13 empfiehlt drei
aufeinanderfolgende leere Ranges. Eine simulierte abgebrochene Reservierung 0–99,
gefolgt von real signierten Outputs ab 100, bleibt vollständig unentdeckt; der
neue Counter bleibt null, obwohl die Mint wieder für Outputs freigegeben wird.

Abhilfe: mindestens aktuelle NUT-13-Suche, gespeicherte High-Water-Marks und
explizite erweiterte Suche. Beliebig große reservierte, nie signierte Lücken sind
auch mit drei Batches nicht durch die Phrase beweisbar. Ein Vollbackup bleibt
notwendig; bei unsicherer/kompromittierter alter Writer-Instanz Guthaben unter
einen neuen Seed migrieren.

### Weitere Integrations- und Spezifikationslücken

| Priorität | Befund / Beleg                                                                                                                                                                                    | Konsequenz                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| P1        | `src/host/cashu-service.ts:78`: Writer-Besitzer nur in einer Map pro Service; ohne Cashu fehlt `acquire()`. `CashuEngine.exclusive` und `Transfers.exclusive` schützen nur die jeweilige Instanz. | Kein globaler Wallet-Lock zwischen Shell-Tabs, Prozessen, Geräten oder sämtlichen LNURLcash-/Backup-Aktionen.                            |
| P1        | `Vault.backup()` liest mehrere Items; LNURLcash-Records und `transfers-v1` sind nicht atomar mit `cashu-v1`. UI-`busy` schützt nicht alle zukünftigen API-/Adapter-Aufrufe.                       | Backup und alle Mutationen müssen denselben Writer/Transaktionsrahmen verwenden.                                                         |
| P1        | Phrase, Cashu-Seed, Proofs und lokale AES-Verarbeitung befinden sich im Napplet (`Vault`, `CashuEngine`).                                                                                         | „Secrets verlassen nie den Signer“ ist für diesen Code falsch. Die Host-Sandbox ersetzt keine sichere Wallet-Verwahrung.                 |
| P2        | Transfers persistieren Verknüpfungen erst nach dem Erstellen einzelner Ziel-/Quelloperationen. `resume` behandelt nur funding/claiming.                                                           | Abbruch in preparing/quoted kann verwaiste Quote/Reservierung hinterlassen. Keine zweite Zahlung, aber fehlender Reconcile-/Cancel-Flow. |
| P2        | Der aktuelle NAP-STORAGE-Entwurf isoliert nach `(dTag, aggregateHash)`. Kehtos Defaultquota beträgt 512 KiB. Ciphertext, Journale und Artwork wachsen.                                            | Upgrade-Migration, Kapazitätswarnungen und atomare Ablage außerhalb des Artifact-Scope fehlen. Nicht einfach Scope-Isolation abschalten. |
| P2        | Der bestehende Regtest-Helper wartet auf LND-Sync, erzeugt aber bei alter vorhandener Kette keinen frischen Block. Bitcoin-Daten liegen in einem anonymen Image-Volume.                           | Wiederanlauf braucht frischen Block; Neuaufbau muss Bitcoin-Volume explizit benennen. Bestehendes Volume nicht ersetzen.                 |
| P2        | FORMAT scheitert unter aktuellem Windows-Checkout; historischer grüner Check ist nicht übertragbar.                                                                                               | EOL-Verhalten separat und klein korrigieren; bestehende Änderungen nicht überformatieren.                                                |
| P2        | Aktuelles dni-Upstream ist `b391530` (note tags), lokaler Ausgangspunkt älter.                                                                                                                    | Feature-Parität anhand des neuen Stands nachführen; kein stilles Merge in dieser Prüfung.                                                |

## Aktuelle Spezifikationen gegen Implementierung

Die exakten Quellenstände und Statusbelege stehen in
[SOURCES-2026-09-09.md](SOURCES-2026-09-09.md). „Im Repository vorhanden“,
„PR gemergt“, „draft“ und „SDK implementiert“ sind unterschiedliche Aussagen.

- **Manifest/NIP-5D:** Der offene NIP-5D-PR 2303 definiert Napplet-Kinds
  5129/15129/35129 und übernimmt das Tag-Schema von NIP-5A. NIP-5A selbst
  beschreibt nsites mit 15128/35128. Die NAP-Registry nennt dagegen noch 35128
  für Napplets. Bearletts Build erzeugt 35129: zum aktuellen NIP-5D-PR und SDK
  passend, kein Beweis eines verabschiedeten NIP-5D. Der Dateiname
  `.nip5a-manifest.json` stammt aus dem Plugin.
- **Sandbox:** `allow-scripts`, kein `allow-same-origin`, Namespace vor App-Code,
  Source-Binding und CSP sind im Preview belegt. NIP-07 darf nicht direkt in das
  Napplet injiziert werden. Standardnahe Wallet-Verwahrung erfordert den Host.
- **SHELL:** verpflichtender Handshake; beide Apps warten auf `shell.ready()`.
  Discovery zeigt Fähigkeiten, ersetzt aber nicht Freigabe, dauerhaften Speicher
  oder vertrauenswürdige Scope-Zuordnung.
- **INTENT/INC:** registrierte APIs, NAP-INTENT/SHELL in Registry Active;
  `wallet`, `bearer-designer` und alle vier `wallet/*`-Verträge bleiben eigene
  Konventionen. `ok/handled` ist Zustellung, keine Zahlungs-/Importbestätigung.
  Cold-start braucht subscription-aware Zustellung; nur `shell.ready` kann zu
  früh sein. Ziel- und Senderbindung im echten Paja prüfen.
- **Design:** `noteDesignMessage` und `parseDesign` lassen nur Darstellung zu.
  Kein Betrag, Proof, k1, Invoice oder spendbarer QR im Vertrag. Freitext und
  hochgeladene Bilder können vom Nutzer natürlich beliebige Inhalte enthalten;
  die App darf nie automatisch Secrets hineinrendern.
- **STORAGE:** scoped KV, keine CAS-/Mehrfachrecord-Transaktionen oder
  Gerätekoordination. Entwurf verlangt Reload-Persistenz, keine universelle
  Wallet-Durabilitätsgarantie. F00 ist zusätzlich ein konkreter Implementierungsfehler.
- **IDENTITY/Signer:** `getPublicKey` ist read-only und beweist keine Kontrolle.
  Paja implementiert `none/dev/nip07/nip46`, keine NIP-55-Anbindung. Ein
  Wallet-eigener Key wird nicht durch IDENTITY oder NIP-07 erzeugt.
- **RELAY/OUTBOX:** `publishEncrypted` und Routing sind vorhanden; keine
  allgemeine Napplet-Decrypt-API (`identity.decrypt` wurde entfernt). ACKs und
  Outbox-Routing sind weder Backup-Aufbewahrungsvertrag noch verteilter Lock.
- **RESOURCE:** Byteauflösung, kein freier POST-Transport. Die Cashu-Capability
  bleibt erforderlich und experimentell. Auch LNURLcash-Mutationen per GET
  liegen semantisch außerhalb einer rein lesenden Resource-Capability. Der
  Nonce vermeidet URL-Caches, erteilt aber keine Zahlungsberechtigung.
- **LUD-25:** nach wie vor draft auf Branch `lnurlcash`; LUD-03/06/12/16/17/21
  liefern die Bausteine. Rotate-/Split-/Merge-Replacements vorher speichern;
  ein verschwundenes k1 ist kein Zahlungsnachweis. Ohne Preimage braucht die
  Brücke nachgewiesenen Quellverbrauch und Ausgabe zum exakt gebundenen Ziel.
- **Cashu:** NUT-00 A/V3 wird noch gelesen, ist deprecated; B/V4 empfohlen.
  NUT-01/02: Keyset/Einheit/Fees, NUT-03: Swap; 04/05/23: Quotes/BOLT11.
  Fee-PPK wird über Inputs summiert und aufgerundet; Routingreserve und
  Mintgebühren getrennt anzeigen. 07/09 sind hier erforderlich, 08 für Melts.
  NUT-09 benötigt die exakten Outputs inklusive Blinding-Material, 13 die
  versionsabhängige Ableitung für 00- und 01-Keysets und monotone Counter.
  19 ist ein optionaler Requestcache mit TTL, keine Erlaubnis zum blinden
  Wiederbezahlen. 20 schützt Quote-Einlösung und hat einen separaten Counter;
  der vorhandene Ableitungspfad entspricht dem aktuellen NUT-20.
- **Quote-Recovery:** Invoice-/Quote-Ablauf vor neuer Zahlung beachten; eine
  schon bezahlte abgelaufene Quote nicht lokal vernichten. Unbekannte Zahlungen
  reserviert lassen. Moderne `amount_paid/amount_issued/updated_at` werden
  teilweise geprüft; vollständige Bindung und Bilanz in sämtlichen Pfaden fehlt.
- **BOLT11:** Checks für Betrag, Checksumme, Ablauf, Signatur und Paymenthash
  vorhanden. Kein Nachweis der vollständigen offiziellen BOLT11-/Cashu-Vektoren;
  der Crypto-Testinvoice-Generator ist selbst Teil dieser Codebasis. Vor Release
  unabhängige gültige/ungültige Vektoren ergänzen.

## Brenos Projekte: verwertbare Erkenntnisse

### Cashu Sync

Stand `b5bcb00`, Wallet-SDK tatsächlich 4.7.0. Im Code bestätigt: Snapshot v0
fest auf `usd`, ein Authority-Mint, Event 30078 mit eigenem d-Tag, NIP-44 an
eigenen Pubkey; Eventsignatur, Schema und innerer/äußerer Vorgänger werden geprüft.
Go 1.26, Khatru 0.19.1, SQLite 1.56.0. `store.Advance` prüft `prev` gegen den
aktuellen Head und schreibt beide innerhalb einer SQLite-Transaktion; eine
Verbindung/ein Prozess serialisiert v0. NIP-42-Auth, Autorenbindung und Limits
liegen in der Relay-Policy. Der Coordinator speichert vorbereitete Requests und
verlangt Relay-Zustimmung vor Submit; unklare Ergebnisse bleiben zur Abklärung.

Das ist mehr als „Backups auf gewöhnlichen Relays“, aber kein universelles
Fencing am Mint. Bereits autorisierte Requests lassen sich nach einem
Gerätewechsel nicht durch einen Relay-Head zurückrufen. Die starke Annahme ist
ein kooperierender Clientverbund mit einem verfügbaren Koordinationsdienst.
Keine Bearlett-Parität für Tokenimport/-export, LNURLcash oder Multi-Mint.
Die 222 Wallet-Tests und alle vier Go-Testpakete wurden lokal reproduziert;
Pairing auf zwei echten Telefonen und Live-Deployment nicht.

Lizenz: `wallet/LICENSE.md` enthält MIT/Cashu 2023. Für den eigenständigen Relay
und übrige Root-Dateien wurde keine entsprechende Lizenzdatei gefunden. Deren
Code nicht in Bearlett übernehmen. Gute Referenz für Zustandsautomat,
Konfliktbehandlung und Tests; kein Grund, V1 um einen CAS-Dienst zu erweitern.

### Granola

Stand `e25a4ec`, Cashu SDK 4.7.1. `src/cashu/htlc.ts`, Trade-Coordinator,
Proof-Reservierungen und Nostr-Transport bestätigen NUT-14-/P2PK-basierte
HTLC-Swaps mit gemeinsamem Hash, Refund-Zeiten, persistierten Requests und
privater Nostr-Koordination. Web Locks schützen lokal, kein globaler Geräte-Lock.
Das ist eine andere Operation als LNURLcash↔Cashu über BOLT11. 442 Tests
bestanden, sieben übersprungen; kein eigener Live-Testnet-Swap durchgeführt.

Keine LICENSE-Datei und keine Lizenzangabe im package.json gefunden. Keine
Codeübernahme. Architektur-/Fehlermatrix als Lesereferenz nützlich; funktional
außerhalb V1.

### Envelope

Stand `7d7ff1c`, installierter Paja 0.11.0. Pointer-Resolver nutzt Kehto zum
Prüfen von Signatur, Manifest, Hashes und Blobs. Der angepasste Host startet
verifizierte Targets; Intent-Verträge kommen aus dem Manifest. Der Opener
transportiert Startzustand per Intent. Grenzen sind Timeout, fehlender Vertrag
und fehlendes erstes Online-Caching; Offlinecache macht keine Mint erreichbar.
36 lokale Tests bestanden, öffentliche Live-E2E bewusst nicht ausgeführt.

`package.json` und Root-Lockeintrag deklarieren MIT; keine eigenständige LICENSE
gefunden. Das ist eine positive Lizenzdeklaration, aber Copyright-/Lizenztext
vor Übernahme klären. Adapteridee verwertbar. Bearlett-Secrets nicht in
Envelope-Fragmente/Browserhistorie kopieren; Encoding ist keine Verschlüsselung.

### Napplets Workshop

Stand `45459f6`, SDK ^0.12.0, Shim ^0.13.0, Plugin ^0.8.1: deutlich ältere
Referenz. Kleines Breakout-/SDK-Manifest-Beispiel, MIT-LICENSE vorhanden.
Typecheck/Build bestehen. Conformance-CLI meldet trotz Warnungsfehler insgesamt
CONFORMANT: `theme`, `storage`, `identity` wurden ohne Deklaration emittiert;
Lifecycle nicht gemessen. Kein Wallet-/Signer-/Recovery-Nachweis. Geeignet als
kleine Lernreferenz mit erhaltenen Lizenzhinweisen, nicht als aktueller
Produktionsvertrag.

## Noch fehlende Nachweise

Ein echter integrierter Kehto/Paja-Host mit Cashu-Freigabe, belastbarem Storage,
Upgrade-Migration und Signer; vollständige Fault-Matrix, unabhängige Vektoren,
Relay-Roundtrip/Restore, Wallet-Key-Lifecycle, Geräteübergabe, reale Android-
Lifecycle-/Keystore-/Kamera-/NFC-Prüfung. Das konkrete Inventar, Start/Stop und
die ausführbaren Prüfkommandos stehen in
[INFRASTRUCTURE-2026-09-09.md](INFRASTRUCTURE-2026-09-09.md).

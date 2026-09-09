# Infrastruktur und reproduzierbarer Testplan

Stand: 9. September 2026. Die Ergebnisse und ihre Grenzen stehen im
[Machbarkeitsbericht](FEASIBILITY-2026-09-09.md), Versionen der Quellen in
[SOURCES](SOURCES-2026-09-09.md). Alle folgenden Windows-Befehle sind PowerShell,
sofern nicht ausdrücklich anders angegeben. Arbeitsverzeichnis: `G:\Github\bearlett`.
Die Testkonfiguration enthält ausschließlich öffentliche Regtest-Zugangsdaten.

## Tatsächliches Inventar

| Komponente                        | Vorhandener Stand / Zweck                                                                                                       | Port / persistente Daten                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Node/npm/Git                      | 24.15.0 / 11.12.1 / 2.53.0.windows.1; Builds und Tests ausgeführt                                                               | Kein Dienst; node_modules, Lockfile, Git                                                                    |
| pnpm                              | Vorhanden und für Workshop verwendet; Projekt deklariert 10.8.0                                                                 | Paketcache; ausgeführte pnpm-Patchversion nicht separat protokolliert                                       |
| WSL Ubuntu 2                      | Vorhanden; beim Start zunächst gestoppt                                                                                         | Docker liegt innerhalb WSL, kein Windows-docker im PATH                                                     |
| Docker/Compose                    | Engine 29.3.0 / Compose 5.1.0                                                                                                   | Lokaler WSL-Daemon, vorhandene Images/Volumes                                                               |
| Bitcoin                           | `bitcoin/bitcoin:29.0`, Regtest                                                                                                 | Nur intern: RPC 18443, P2P 18444, ZMQ 28332/28333; **anonymes Image-Volume** unter `/home/bitcoin/.bitcoin` |
| LND Alice/Bob                     | `lightninglabs/lnd:v0.19.3-beta`; verbundener finanzierter Regtest-Kanal                                                        | Je intern REST 8080, gRPC 10009, Peer 9735; `bearlett-regtest_alice`, `_bob`                                |
| Nutshell                          | `cashubtc/nutshell:0.20.3`, LND Bob, Inputfee 100 PPK                                                                           | `127.0.0.1:43338` → 3338; `bearlett-regtest_cashu`, Bob-Zugang nur lesend                                   |
| LNURLmint                         | Bestehendes Image `bearlett-regtest-lnurl:latest`, Quelle `bd21f6119ee70297c127531e139d517453c26587`, LND Alice, 1 sat Basisfee | `127.0.0.1:48111` → 8111; `bearlett-regtest_lnurl`, Alice-Zugang nur lesend                                 |
| Playwright/Chromium               | Paket 1.63.0, Browserbuild 1243 vorhanden; 12 Tests ausgeführt                                                                  | Kurzlebiger lokaler Preview-Server; Screenshots/Testresultate                                               |
| Echter Kehto                      | Gepatchter alter Checkout `14a14155`; Pakettests ausgeführt                                                                     | Host-Port beim späteren Start aus Paja-Ausgabe übernehmen; Hostdaten/Signerprofil separat                   |
| Gewöhnlicher eigener Backup-Relay | **Fehlt als isolierter, geprüfter Bearlett-Dienst**                                                                             | Vorgesehen: Loopback 47777, eigene Relay-Datenbank                                                          |
| Cashu-Sync-CAS-Relay              | Quelle vorhanden, Go-Tests bestanden; nicht als Dienst gestartet                                                                | Für V1 nicht erforderlich; eigener Prozess/SQLite erst bei späterem Experiment                              |
| Android                           | `java`, `adb` und übliche SDK-Verzeichnisse nicht gefunden; kein Emulator-/Gerätenachweis                                       | SDK/JDK, AVD, Debug-APK, Keystore und App-DB fehlen                                                         |
| Go                                | Kein Host-Go gefunden; Tests mit `golang:1.26-alpine`                                                                           | Temporärer Testcontainer, keine Relay-Datenbank                                                             |

Die vollständigen Image-IDs stehen in `outputs/feasibility-2026-09-09/regtest-images.txt`.
Dies sind lokale Image-IDs, keine behaupteten pullbaren Registry-Digests. Die
laufende Kombination wurde getestet; ein frischer Build wurde nicht reproduziert.
Nach Abschluss wurden **nur die fünf Bearlett-Regtest-Container gestoppt**,
alle Datenvolumes erhalten.

WSL-Start aktivierte aufgrund bestehender Restart-Policies auch fremde
`terrcvm-corpus`-Dienste: strfry auf 7777, Blossom auf 3000/8787. Ein Blossom-
Dienst meldete unhealthy. Diese Dienste wurden weder geändert noch gestoppt
und zählen nicht als Bearlett-Testinfrastruktur.

## Minimalumgebung: vorhandenen Regtest wieder starten

Die Kopie nach G: enthält `work/lnurl-mint` nicht. Das bestehende Image und die
Container genügen zum Wiederanlauf. Zuerst den Bestand prüfen:

```powershell
Set-Location G:\Github\bearlett
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml ps -a
wsl -d Ubuntu -- docker image inspect bearlett-regtest-lnurl:latest --format '{{.Id}}'
wsl -d Ubuntu -- docker volume ls --filter name=bearlett-regtest
wsl -d Ubuntu -- docker inspect bearlett-regtest-bitcoin-1 --format '{{json .Mounts}}'
```

In Terminal A im Vordergrund laufen lassen, damit WSL nicht als untätig beendet
wird. `--no-recreate` erhält insbesondere die Bitcoin-Volume-Zuordnung:

```powershell
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml up --no-recreate --no-build
```

In Terminal B bei vorhandener, älterer Kette einen frischen Block erzeugen.
Ein bereits geladenes Wallet meldet beim `loadwallet` einen entsprechenden
Fehler; andere Fehler erst beheben, bevor man fortsetzt:

```powershell
Set-Location G:\Github\bearlett
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only loadwallet bearlett
$bearlettMiningAddress = wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only getnewaddress
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml exec -T bitcoin bitcoin-cli -regtest -rpcuser=bearlett -rpcpassword=regtest-only generatetoaddress 1 $bearlettMiningAddress
node scripts/regtest.mjs
npm run test:regtest
```

**Reproduzierter Startfehler:** Der Helper erzeugt ab Höhe 101 keine neuen
Initialblöcke. Bei der alten Kette waren LND und Bitcoin auf gleicher Höhe,
aber `synced_to_chain` blieb false. Der neue Block beseitigte das Problem.
Eine frische Kette bootstrapped der Helper selbst mit 101 Blöcken, Funding
und Kanalöffnung. Der Sonderweg oben ist für den vorhandenen Bestand.

Den Status explizit prüfen und anschließend nur dieses Projekt stoppen:

```powershell
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml exec -T alice lncli --network=regtest getinfo
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml exec -T alice lncli --network=regtest listchannels
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml stop
```

Kein `down -v`, kein globales Prune. Bitcoin- und LND-Daten müssen konsistent
zusammen erhalten werden. Ein neuer Bitcoin-Container ohne die alte Kette ist
kein zulässiger Reparaturversuch für bestehende LND-Volumes.

### Frischer LNURLmint-Build: noch separat zu verifizieren

Für einen frischen Checkout ohne vorhandenes Image ist zuerst die fehlende
Quelle am im Compose referenzierten Pfad bereitzustellen. Nur ausführen, wenn
der Zielpfad noch nicht existiert:

```powershell
git clone https://github.com/lnurlcash/lnurl-mint.git work/lnurl-mint
git -C work/lnurl-mint checkout --detach bd21f6119ee70297c127531e139d517453c26587
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml build lnurl
```

Das ist ein aus der bestehenden Compose-Konfiguration abgeleiteter Buildweg,
kein in dieser Session bestandener Clean-Build. Für eine wirklich neue
isolierte Umgebung zuerst in einer **Kopie** des Compose-Files ein explizites
Bitcoin-Volume ergänzen und sämtliche Dienste unter einem neuen Projektnamen
aufsetzen. Die bestehende Umgebung nicht durch neue Volumes ersetzen. Der
heutige Helper fixiert außerdem den bisherigen Compose-Pfad: vor parallelen
Stacks braucht er eine explizite Konfigurationsauswahl.

## Prüfkommandos

Bearlett, jeweils aus dem Projektroot:

```powershell
npm test
npm run tsc
npm run build
npm run build:napplet
npm run build:notes
npm run test:napplet:browser
node node_modules/vitest/vitest.mjs run --config docs/checks/feasibility.config.ts
npm run format:check
node node_modules/prettier/bin/prettier.cjs --check . --end-of-line auto
```

Die fünf isolierten Reproduktionen bestätigen gegenwärtig die Fehler F00–F04.
Sie sind absichtlich außerhalb der normalen Testsuite und keine bestandenen
Wallet-Abnahmetests. Formatcheck ist bekanntermaßen nicht grün; `--end-of-line
auto` dient der Ursachenabgrenzung und ersetzt nicht die Projektregel.

Die Kehto-Pakettests liefen im erhaltenen alten Checkout. Weder dieser
Checkout noch der Patch wurden verändert:

```powershell
Set-Location C:\Users\FLX\Documents\Codex\2026-09-08\https-github-com-lnurlcash-lnurl-wallet\work\bearlett\work\kehto
node node_modules/vitest/vitest.mjs run packages/acl packages/firewall packages/runtime packages/services packages/shell packages/paja/src/browser-devtools.test.ts --cache=false
node node_modules/vitest/vitest.mjs run --cache=false
```

Breno-Snapshots sind im Quellenverzeichnis gepinnt. Installationen erfolgten
mit Lockfile und ohne Lifecycle-Scripts; Tests/Builds danach ausdrücklich:

```powershell
Set-Location G:\Github\bearlett\work\spec-check\brenorb--cashu-sync\wallet
npm ci --ignore-scripts
npm run test:ci -- src/sync src/v0
Set-Location G:\Github\bearlett\work\spec-check\brenorb--granola
npm ci --ignore-scripts
npm test
Set-Location G:\Github\bearlett\work\spec-check\brenorb--envelope
npm ci --ignore-scripts
npm test
Set-Location G:\Github\bearlett\work\spec-check\brenorb--napplets-workshop
pnpm install --frozen-lockfile --ignore-scripts
pnpm verify
pnpm test:conformance
```

Go-Relaytests ohne Installation von Host-Go; Quellmount nur lesend:

```powershell
wsl -d Ubuntu -- docker run --rm --name bearlett-spec-cas-test -v /mnt/g/Github/bearlett/work/spec-check/brenorb--cashu-sync/relay:/src:ro -w /src golang:1.26-alpine go test ./...
```

Netzwerkzugriff wird für Dependencies benötigt. Keine öffentlichen
`test:live`-Läufe, keine realen Guthaben. Workshop-Conformance prüft nicht
sämtliche Lifecycle-Fälle und meldet eine Warnung zu undeclared domains.

## Optionale Backup- und Geräteumgebung

### Gewöhnlicher Relay

Für den nächsten Backup-Spike einen eigenen lokalen Relay vorsehen. Kein CAS
für den bestätigten Ein-Schreiber-Ansatz. Der folgende strfry-Aufbau ist ein
**quellengeprüfter Vorschlag, noch nicht gebaut oder Ende-zu-Ende getestet**.
Die offiziellen Docker-Builddateien verwenden derzeit Alpine 3.18.3; vor
dauerhaftem Betrieb Baseimage und Buildabhängigkeiten neu prüfen.

```powershell
Set-Location G:\Github\bearlett
git clone https://github.com/hoytech/strfry.git work/spec-check/hoytech--strfry
git -C work/spec-check/hoytech--strfry checkout --detach 4cd3cf64850caf47dda46c2a2abbbf3525a64d10
git -C work/spec-check/hoytech--strfry submodule update --init --recursive
$bearlettRelayConfig = Get-Content work/spec-check/hoytech--strfry/strfry.conf -Raw
$bearlettRelayConfig.Replace('bind = "127.0.0.1"', 'bind = "0.0.0.0"') | Set-Content outputs/feasibility-2026-09-09/backup-relay.conf
wsl -d Ubuntu -- docker build -t bearlett-spec-strfry:4cd3cf6 /mnt/g/Github/bearlett/work/spec-check/hoytech--strfry
wsl -d Ubuntu -- docker run -d --name bearlett-backup-relay -p 127.0.0.1:47777:7777 -v bearlett-backup-relay-db:/app/strfry-db -v /mnt/g/Github/bearlett/outputs/feasibility-2026-09-09/backup-relay.conf:/app/strfry.conf:ro bearlett-spec-strfry:4cd3cf6
wsl -d Ubuntu -- docker logs bearlett-backup-relay
```

Stop/erneut starten: `wsl -d Ubuntu -- docker stop bearlett-backup-relay` bzw.
`wsl -d Ubuntu -- docker start bearlett-backup-relay`. Der Host-Port bleibt
Loopback; Container-internes `0.0.0.0` bedeutet hier keine öffentliche Freigabe.
Eigene Datenbank behalten. Abnahme: signiertes NIP-78-Event veröffentlichen,
ACK prüfen, per Event-ID erneut lesen, Signatur/Entschlüsselung/Restore prüfen,
Relay neu starten und denselben Zustand wieder lesen. Bearletts dafür nötiger
Backup-Client fehlt noch. Reguläre Relay-Funktion ist kein privater Lesezugang;
Verschlüsselung und gewünschte Auth-Policy separat testen.

### Host, Signer, TLS und Android

Der Preview-Host ersetzt nicht einen echten Kehto-/Paja-Test. Fehlender
Prüfaufbau: verifizierte Wallet-/Notes-Artefakte, eigene Browserprofile, explizite
Cashu-/Wallet-Berechtigung, NIP-07- oder NIP-46-Testsigner mit ausschließlich
synthetischer Identität, persistenter Host-Store samt Quota-/I/O-Fehlerinjektion.
Anschließend Upgrade des Artefakthashes und Intent-Cold-start prüfen. Blossom
oder nsite sind erst für entsprechende Installation/Verteilung nötig, nicht
für den beschriebenen Mint-Regtest.

Für Android gemäß [offizieller Capacitor-Umgebung](https://capacitorjs.com/docs/getting-started/environment-setup)
Android Studio ab 2025.2.1 samt JDK, SDK 36 und Platform-Tools installieren.
API-36-Emulator plus ein echtes NFC-fähiges Android-Gerät für NIP-55/Amber,
Kamera, NFC und hardwareabhängigen Keystore bereitstellen. Diese Installation
und Gerätetests wurden nicht durchgeführt. Nach Einrichtung zuerst:

```powershell
adb version
adb devices -l
adb reverse tcp:43338 tcp:43338
adb reverse tcp:48111 tcp:48111
adb reverse tcp:47777 tcp:47777
```

ADB-Kommandos dienen nur einer lokal verbundenen Debug-Umgebung. Der Emulator
kann alternativ `10.0.2.2` für den Windows-Host verwenden. Auf einem echten
Telefon bezeichnet `127.0.0.1` dagegen das Telefon. WSL-zu-Windows-Weiterleitung
vorher testen. Für Browser-/Host-Konformität eine lokale, auf dem Gerät
vertrauenswürdige HTTPS/WSS-Terminierung und korrekt auflösbare Mint-Hostnamen
ergänzen; keine Zertifikatsprüfungen im Produkt abschalten. Die fest gemappten
`.test`-Identitäten des Node-Regtests lösen das nicht automatisch.

Beide Mints beantworteten die geprüften OPTIONS-Requests mit
`Access-Control-Allow-Origin: *`; Nutshell erlaubte POST/content-type. Das
belegt Preflight-Header, nicht den gesamten Browserflow, TLS, Host-Firewall oder
alle Endpoints. Backup-Relay, Quota-Tests und alle Mutationen müssen über die
später tatsächlich verwendeten Adapter erneut geprüft werden.

### Ressourcen und Kosten

Gemessener Leerlauf der fünf Regtest-Dienste: zusammen ungefähr **341 MiB RAM**,
jeweils unter 0,2 % CPU beim Snapshot. Imagegrößen: Bitcoin ca. 212 MB, LND
224 MB, Nutshell 1,53 GB, LNURLmint 236 MB; zusammen ungefähr 2,2 GB, ohne Caches.
Das ist kein Last- oder Android-Benchmark. WSL meldete ca. 15,6 GiB RAM und
16 GiB Swap; ausreichend freier Platz war vorhanden.

Planungsbudget, ausdrücklich Schätzung: 4 GB RAM für Builds/Mints; 8–16 GB
mit Android-Emulator, 10–30 GB zusätzlicher Plattenplatz für SDK/AVD/Images.
Ein kleiner lokaler Relay sollte zunächst mit 256 MiB Budget gemessen werden.
Kein VPS, keine bezahlten APIs, keine echten Sats und keine Storegebühr für
lokale Tests oder APK-Sideload erforderlich. Strom/Download und eventuell
fehlende Testhardware bleiben reale Kosten; nichts wurde gekauft.

## Noch fehlende Abbruch- und Recovery-Nachweise

Für **beide Transferrichtungen** dieselben Unterbrechungspunkte automatisieren.
Ein erfolgreicher Node-Test mit MemoryStorage deckt keinen Prozess-/Datenträger-
Crash ab. Testinstrumentierung soll nach einem benannten Journal-Checkpoint
stoppen; anschließend mit einem neuen Prozess/Profil und erhaltenem Store
starten. Keine zufälligen Sleeps als alleinigen Fehlerauslöser verwenden.

| Unterbrechung / Störung                            | Heute belegt                                                | Nächster notwendiger Nachweis                                                         |
| -------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Vor Reservierung / fehlgeschlagener lokaler Write  | Lokale Fail-closed-Tests, aber F00 im echten Shim bestätigt | Quota-/I/O-Fehler im Host; **kein** Mint-Request nach negativem Commit                |
| Nach Counter/Outputs, vor Netzwerk                 | Fixtures; F04 bestätigt Counter-Lücke                       | Browser/Android kill; exakte Outputs erhalten, Counter nie zurücksetzen               |
| Quote erzeugt, Transferlink noch nicht geschrieben | Codeprüfung, keine vollständige Crash-Matrix                | Verwaiste Quotes/Reservierungen erkennen und sicher weiterführen/abbrechen            |
| Request gesendet, Antwort verloren                 | Echter Regtest Cashu→LNURLcash mit Restore, genau ein Melt  | Gleicher Lauf LNURLcash→Cashu und sämtlicher unmittelbarer mint/swap/melt-Pfade       |
| Mint bestätigt, vor lokalem Asset-Commit           | Unit-Fixtures; F01 zeigt Lücke bei fehlendem Change         | Kill, NUT-07/09-Recovery, korrekte Wertbilanz und keine zweite Zahlung                |
| Ziel gespeichert, vor Source-/Change-Abschluss     | Journalpfade geprüft, kein vollständiger Gerätebeleg        | Wiederaufnahme darf weder doppelt gutschreiben noch unvollständig complete melden     |
| Abgelaufene Quote / ungeklärte Zahlung             | Teilweise Unitchecks                                        | Zahlungsverbot bei neu abgelaufener Quote, Erhalt schon bezahlter Ansprüche           |
| Fremdes/unvollständiges/altes Backup               | F02/F03 reproduziert                                        | Vollständige Authentifizierung und Identität vor erstem Write; alten Stand sperren    |
| Zwei Tabs/Writer, Backup während Mutation          | Nur instanzlokale Leases/Mutexe                             | Gemeinsamer Store-Writer, atomarer Snapshot, kein verlorenes Update                   |
| Handover vor/nach jedem Checkpoint                 | Fehlend                                                     | Zwei Profile/Geräte, Quelle bleibt gesperrt, verlorene ACKs wiederaufnehmbar          |
| Relay offline/alter Head/fehlende Chunks           | Fehlend                                                     | Verschlüsselter Roundtrip, Wiederanlauf, konsistenter Restore statt stiller Rollbacks |
| Signerablehnung/-wechsel, Activityverlust          | Fehlend                                                     | Identität/Requestbindung; keine versehentlich neue Wallet/erneute Zahlung             |
| Android force-stop/Lock/Neustart/NFC               | Fehlend                                                     | Echter Prozesskill und Gerät, transaktionaler Store, Entsperrung und Reconcile        |

Release-Grenze: F00–F04 beheben, offizielle externe Testvektoren ergänzen,
Host-/Browser-/Gerätetests bestehen lassen und unabhängigen Review durchführen.
Zusätzliche Mintimplementationen und Netzwerkausfälle verbreitern danach die
Interoperabilitätsbelege. Granolas HTLC-Testnet ist kein Ersatz für diese
Lightning-/Bearer-Wallet-Matrix.

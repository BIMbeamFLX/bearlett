# Bearlett: Korrekturen und Übergabe zum externen Audit

Stand: 9. September 2026, abschließender lokaler Prüflauf. Basis:
`87fd4f01156a2c3f701eb473386cca727257d0c2`; Arbeitsbranch:
`fix/bearlett-security-boundaries`. Dies ist ein geprüfter Teststand, keine
Freigabe für echte Guthaben. Keine Veröffentlichung und kein Merge.

Dieser Bericht aktualisiert den Status aus [FEASIBILITY](FEASIBILITY-2026-09-09.md)
und [INFRASTRUCTURE](INFRASTRUCTURE-2026-09-09.md). Deren ursprüngliche Befunde,
Testzahlen und Reproduktionen bleiben als historische Belege erhalten.
Nappelin ist die Plattform, Bearlett die Brieftasche. Granola bleibt außerhalb von V1.

## Was geändert und nachgewiesen wurde

| Bereich                     | Korrektur                                                                                                                                                                                                                      | Beleg / Grenze                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Zahlungszustimmung          | Bestätigte Note und Rechnung werden vor dem ersten asynchronen Speicherzugriff festgehalten. Ein Intent befüllt die Oberfläche; eine Zahlung benötigt die Wallet-Bestätigung.                                                  | Browser-Regressionsfall ändert die Rechnung während eines verzögerten Reads; bezahlt wird nur die bestätigte Rechnung.                          |
| Entsperrung                 | Eigenes Wallet-Passwort bleibt erforderlich. Lock funktioniert während einer laufenden Anfrage; alte Unlock-/Create-/Reset-Antworten öffnen keine neue Sitzung. Unvertrauenswürdige DOM-Eingaben verlängern den Timeout nicht. | Unit- und Browser-Tests; keine behauptete Isolation gegenüber einem kompromittierten übergeordneten Host.                                       |
| F00: Speicherfehler         | Eigener Storage-Adapter verlangt explizites `ok: true`, passende Request-ID, Antwortart und Parent-Quelle; Fehler und Timeout brechen ab.                                                                                      | Negatives Write-ACK reproduziert und abgefangen. Das installierte SDK selbst wurde nicht geändert.                                              |
| F01: Wechselgeld            | Bezahlte Cashu-Quotes werden an das Journal gebunden. Fehlendes Change wird mit den bereits gespeicherten Blank-Outputs per NUT-09 rekonstruiert. Grenzen, Zuordnung und UNSPENT-Status werden geprüft.                        | Fehlendes, unvollständiges, fremdes, doppeltes und verbrauchtes Change; genau ein Melt bei Antwortverlust.                                      |
| F02: Backup-Vollständigkeit | Backup v2 authentifiziert zusätzlich den gesamten verschlüsselten Bestand einschließlich Namen und eingepacktem Schlüssel. Entfernte Records werden vor dem ersten Import-Write erkannt.                                       | Manipulations-Tests; v1 nur mit ausdrücklich gewähltem Legacy-Import. Keine Aktualitätsgarantie gegen Replay eines vollständigen alten Backups. |
| F03: Falscher Seed          | Ein Cashu-Backup muss zur LNURLcash-Ableitung der Quell- und Zielwallet passen, auch wenn Cashu im Ziel noch deaktiviert ist.                                                                                                  | Fremdseed-Test verlangt Ablehnung ohne Schreibzugriff.                                                                                          |
| F04: Recovery-Lücken        | Scan berücksichtigt bekannte Reservierungen, verwendet standardmäßig 300 leere Counter und erlaubt Startcounter und begrenzte Fortsetzung. Ein Scan gibt den alten Seed niemals zum Schreiben frei.                            | Funds hinter leerem 100er-Bereich und explizite spätere Suche getestet. Ein endlicher Gap ist kein Vollständigkeitsbeweis.                      |
| Bearer-Übergabe             | Empfangene LNURLcash-Secrets werden rotiert. Restore/Seed-Recovery bleibt in Quarantäne; Export zur frischen Wallet reserviert die Kopie als shared. Auch rekonstruiertes Cashu-Change bleibt nach Restore unverified.         | Unit-Tests und echter Mint-Regtest: neue Wallet erhält Wert, alte Kopien sind nach Rotation verbraucht.                                         |
| Lokale Überschneidungen     | Cashu-Mutationen, LNURLcash pay/transform/share und Backup/Restore nutzen den gemeinsamen Lock desselben Storage-Adapterobjekts. Snapshot-Revision erkennt zusätzliche lokale Writes.                                          | Gleichzeitige Engines und Backup während Mutation abgewiesen. Kein Cross-Tab-/Cross-Device-Lock, keine Datenbanktransaktion.                    |

## Abschließende Ergebnisse

| Prüfung                                                               | Ergebnis                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Bearlett Unit-Suite                                                   | **389 bestanden, 1 übersprungen**, keine fehlgeschlagenen Tests                                                            |
| TypeScript                                                            | bestanden                                                                                                                  |
| Original-Webbuild, Wallet-Napplet, Notes-Napplet                      | alle drei bestanden                                                                                                        |
| Playwright / Chromium                                                 | **18 bestanden**, 9 je Desktop- und Mobil-Viewport, keine Retries/Flakes                                                   |
| Bitcoin/LND/Nutshell/LNURLmint Regtest                                | **1 vollständiger Integrationsfall bestanden**                                                                             |
| Nappelin Hangar, Identität, Locker, Login-Lifecycle                   | **31 bestanden**                                                                                                           |
| TCG-Wallet-Sync                                                       | **6 bestanden**; Mock-Relay/-Blossom, kein realer Backup-Dienst                                                            |
| Formatprüfung aller geänderten Quell-/Testdateien und Diff-Whitespace | bestanden                                                                                                                  |
| Repositoryweiter `npm run format:check`                               | weiterhin nicht grün; bestehende Format-/Zeilenende-Probleme außerhalb dieses Fixes, Log `outputs/security-format-all.txt` |

Der übersprungene Alt-Test `src/integration.test.ts` benötigt `MINT_K1` und eine
separate Mint auf Port 8137. Diese Voraussetzung wurde nicht künstlich gesetzt.
Der separate Regtest verwendet reale lokale Dienste und ausschließlich Testgeld.
Mobil-Viewport bedeutet Chromium mit kleiner Bildschirmgröße, kein Android-Gerät.
Build-Warnungen zu Vite-Konfiguration, veraltetem inlineDynamicImports und dem
großen Original-Webbundle sind weiterhin vorhanden.

Der historische Negativtest `docs/checks/feasibility.test.ts` wurde ebenfalls
erneut ausgeführt: **4 absichtlich überholte Fehlerbehauptungen schlagen nun fehl**
(F01–F04). F00 besteht dort weiterhin, weil er das unveränderte installierte SDK
direkt prüft. Das ist keine grüne Abnahmesuite. Die entsprechenden positiven
Regressionsprüfungen liegen jetzt unter `src/napplet/`.

Die Nappelin- und TCG-Tests liefen gegen die vorhandenen Arbeitskopien; deren
HEADs waren `1b2f2c8ca84e779aa51c31ce2d274341aca50c68` beziehungsweise
`d7535057480d3a16fcb6878eba78d70c66951fc5`. Nicht als unveränderte Checkouts oder
vollständiger integrierter Bearlett-in-Nappelin-Nachweis zu verstehen.

## Wichtigste offenen Aufgaben für den Audit

1. **Gerätewechsel ist noch kein fertiger Ablauf.** Nach Backup-Restore wird
   der alte Seed dauerhaft als Recovery-Quelle behandelt. Im Regtest werden
   Zielnote und Wechselgeld in eine frische Wallet rotiert; das alte
   Transferjournal bleibt `claiming`. Ein wiederaufnehmbarer Migrationsablauf
   mit Verknüpfung und Abschluss beider Journale fehlt. Den alten Seed nicht
   durch einen scanned-Schalter entsperren.
2. **Host-Integration und Speichervertrag.** Bearlett verlangt jetzt bei
   `storage.get`, `storage.set` und `storage.keys` explizites `ok: true`.
   Ältere Hosts ohne dieses Feld werden abgewiesen. Der Preview-Host erfüllt
   dies. Echter Kehto/Paja/Nappelin-Host mit dauerhaftem Store und Cashu-
   Capability muss angepasst und separat getestet werden. Ein ACK beweist
   allein noch keinen fsync oder atomaren Datenträger-Commit.
3. **Writer- und Crash-Grenzen.** Der lokale WeakMap-Lock schützt nur dasselbe
   Adapterobjekt. Er ersetzt keine exklusive Host-Lease und umfasst nicht
   jede LNURLcash-Methode oder den gesamten protokollübergreifenden Transfer.
   Multi-Tab, Prozesskill an jedem Journal-Schritt und unvollständiger reiner
   LNURLcash-/Legacy-Import benötigen zusätzliche Tests und einen belastbaren
   Speicheradapter. Der Restore-Marker deckt bisher insbesondere Cashu-
   Gesamtimporte ab.
4. **Schlüssel und Isolation.** Plattformschlüssel und Wallet-Passwort sind
   getrennt, aber ein bösartiger Parent-Host kann eine Web-Sandbox beeinflussen.
   Wallet-Nostr-Key, dessen Ableitung/Verwahrung, Recovery-UX und Schutz gegen
   kompromittierte Nappelin-Logins sind noch kein durchgehend implementierter
   Systemnachweis. Die Wallet verarbeitet ihre Secrets im eigenen JS-Prozess.
5. **Blossom/Nostr und Android fehlen als echte Integrationsnachweise.**
   Bearlett besitzt noch keinen fertigen Remote-Backup-Client. Kein isolierter
   Blossom-/Nostr-Roundtrip wurde für diesen Stand ausgeführt; TCG-Sync-Tests
   verwenden Mocks. Android-App, Keystore, Signer, NFC, Kamera und echte
   Lifecycle-/Gerätetests bleiben offen. Der Regtest benötigt diese Dienste nicht.
6. **Weitere Prüfbreite.** Externe Protokollvektoren, weitere Mintimplementationen,
   vollständige Abbruchmatrix in beiden Transferrichtungen und adversariale
   Mint-/Hostantworten ausbauen. Tests ersetzen keine kryptografische Prüfung.

## Reproduzieren und lokal ansehen

Aus `G:\Github\bearlett`, mit vorhandenen npm-Abhängigkeiten:

```powershell
npm test
npm run tsc
npm run build
npm run build:napplet
npm run build:notes
```

Die lokale Vorschau ist unter `http://127.0.0.1:4190/wallet` verfügbar, solange
der Preview-Prozess läuft. Sie verwendet In-Memory-Speicher und Mock-Mints;
Neuladen verliert die Sitzung. Sie ist nicht an die realen Regtest-Mints gebunden.
Zum erneuten Start in Terminal A:

```powershell
$env:PORT='4190'
node scripts/napplet-host.mjs
```

In Terminal B, bei bereits laufendem eigenen Preview-Host:

```powershell
$env:BEARLETT_EXTERNAL_HOST='1'
$env:PLAYWRIGHT_JSON_OUTPUT_FILE='outputs/security-browser-results.json'
node node_modules/@playwright/test/cli.js test --config playwright.napplet.config.ts --reporter=list,json
```

Ohne externen Host die Variable entfernen und `npm run test:napplet:browser`
verwenden. Regtest-Start, frischer Block bei alter Kette, Ports und Volume-
Erhaltung stehen in [INFRASTRUCTURE](INFRASTRUCTURE-2026-09-09.md).
Danach `npm run test:regtest`. Nur diesen Stack stoppen:

```powershell
wsl -d Ubuntu -- docker compose -f /mnt/g/Github/bearlett/tests/integration/compose.yaml stop
```

Die vorhandenen fünf Regtest-Dienste wurden wiederverwendet. Keine fremden
Docker-Projekte geändert, keine Volumes gelöscht, nichts gekauft oder öffentlich
bereitgestellt. Der fehlende Quellpfad für einen frischen LNURLmint-Imagebuild
bleibt im Infrastrukturbericht ausgewiesen.

Maschinenlesbare Ergebnisse liegen lokal unter `outputs/security-*-results.json`;
weitere Logs unter `outputs/security-*.txt`. Entscheidungen stehen in der
ignorierten SQLite-Datei `outputs/feasibility-2026-09-09/audit.sqlite` und werden
mit Hashes der Testbelege in `docs/checks/security-evidence-2026-09-09.json`
exportiert. Keine Wallet-Backups oder spendbaren Token werden eingecheckt.
Die Übergabe enthält lokale Prüfungen; der unabhängige externe Audit steht aus.

# Nappelin: gemeinsamer Zugang zur Wallet

Stand: 2026-09-09. Codeprüfung, Architekturvorschlag und lokale Tests; keine Neuimplementierung oder Live-Freigabe. Nappelin-Commit: `1b2f2c8ca84e779aa51c31ce2d274341aca50c68`.

## Ergebnis

Die vorhandene Nappelin-Identität ist als gemeinsamer Zugang geeignet. Die Wallet-Anbindung ist aber noch nicht durchgängig: Der Hangar reicht Signaturen durch, das TCG-Backup braucht zusätzlich NIP-44. Ein gleicher öffentlicher Schlüssel allein stellt diese Fähigkeit nicht bereit. Die flüchtige Gastidentität eignet sich nicht als wiederherstellbarer Zugang zu Geld.

## Was der Code tatsächlich macht

| Baustein | Befund |
|---|---|
| Hangar-Gast | `keyholder.ts` erzeugt einen zufälligen Nostr-Schlüssel im Worker. Kein Secret-Export, kein dauerhafter Gast-Recovery-Pfad. |
| Figur / Stein | `object-code.ts` erzeugt Locator und Passwort mit jeweils 128 Bit Zufall. Der Code adressiert einen Locker; er ist noch keine vollständige Konto-Provisionierung. `keyholder.ts` lädt das verschlüsselte Secret und entschlüsselt lokal. |
| Locker | `locker-core.ts` implementiert den keys.justworks-Vertrag mit NIP-49 und scrypt logN=16. Er akzeptiert diesen Kostenparameter explizit. |
| Browser-Signer | `extension.ts` delegiert Public Key und Signaturen, kontrolliert Kontoänderungen und Signaturantworten. NIP-44 wird bislang nicht durchgereicht. |
| Öffentliche Identity-Schnittstelle | `types.ts` enthält `pubkey`, `kind`, `signEvent`, `dispose`; keine Backup-Verschlüsselung. |
| Betreiberidentitäten | `services/agent-api/scripts/mint-identity.mjs` erzeugt Plattform-/Agent-Schlüssel mit NIP-49 logN=20. Das sind keine Spieler-Wallet-Schlüssel und keine direkt kompatiblen Figur-/Stein-Locker-Blobs. Script nicht ausgeführt. |
| TCG-Wallet | Separater P2BK-Ausgabeschlüssel und bestehender Wallet-Snapshot. `nostr-wallet-sync.js` verschlüsselt über `identity.nip44`, nutzt Nostr und bei großen Snapshots Blossom. |
| Hangar-Netzwerk | `host.ts` betreibt für Napplets aktuell ein Speicher-Relay; es ist kein persistenter Nostr-Backup-Dienst. |

NIP-49 schützt den privaten Login-Schlüssel mit einer Passphrase. NIP-44 schützt hier Wallet-Backup-Daten über den Signer. Diese Funktionen ersetzen einander nicht. Das ältere E-Mail-/Shamir-Konzept in `docs/KEY-DESIGN.md` ist nicht der Nachweis eines implementierten Spieler-Recovery-Flows.

## Empfohlene Verbindung für V1

1. **Wiederherstellbare Nappelin-Identität als Zugang.** Unterstützten Signer oder provisionierte Figur/Stein verwenden. Gast vor dauerhafter Geldnutzung in einen wiederherstellbaren Zugang überführen; nicht stillschweigend einen neuen Schlüssel erzeugen.
2. **Geldschlüssel getrennt erhalten.** Vorhandene TCG-P2BK-Schlüssel und Wallet-Secrets bleiben eigenständige Geheimnisse im geschützten Wallet-Zustand. Nicht durch den Nostr-Login-Schlüssel ersetzen. Ein gemeinsamer Login bedeutet nicht einen Schlüssel für alle Aufgaben.
3. **Hostseitigen Backup-Service ergänzen.** Intern NIP-44 im lokalen Worker bzw. über einen geeigneten externen Signer bereitstellen. Napplets erhalten eng begrenzte Wallet-/Backup-Operationen; kein privater Schlüssel wird ins iframe exportiert. Bestehenden TCG-Adapter auf den aktuellen Hangar-/Kehto-Vertrag abbilden.
4. **Transport anschließen.** Persistentes Relay und erlaubten Blossom-Upload/Download im Host konfigurieren. Vollständigen Snapshot zuerst lokal verschlüsseln, Upload zurücklesen und Hash prüfen, dann signierte Referenz veröffentlichen. Blossom speichert in diesem Ablauf bereits verschlüsselte Daten; der Speicherort allein erzeugt keine Verschlüsselung.
5. **Gerätewechsel ausdrücklich durchführen.** Ausstehende Zahlungen klären, letzten bestätigten Zustand sichern, altes Gerät sperren, neues Gerät wiederherstellen und Mint-Zustand abgleichen. Die bisherige Web-Locks-Sperre koordiniert keine anderen Geräte. Ein kopierter Bearer-Token bleibt ausgebbar; für belastbaren Entzug alter Kopien braucht es ein dafür geprüftes Reissue-/Rekey-Verfahren bei der Mint. Eine Nostr-Markierung allein erzwingt das nicht.
6. **Android verwendet denselben Vertrag.** Hostseitige Schlüsselhaltung und geschützter lokaler Speicher, dieselben Snapshot- und Identitätsregeln. Lifecycle-Sperren beim App-Wechsel und Rückkehr vom externen Signer gezielt testen.

Bestehende TCG-Backups lassen sich nur mit ihrem bisherigen Entschlüsselungszugang öffnen. Bei Wechsel der Nappelin-Identität ist eine explizite Migration mit dem alten Zugang nötig. Schlüssel-, Konto- oder Sessionwechsel müssen auch laufende Verschlüsselungsantworten entwerten. Ein Timeout darf niemals automatisch eine leere Ersatz-Wallet anlegen.

## Konkret fehlend / noch nachzuweisen

- NIP-44-Fähigkeit im Worker, Worker-Protokoll, Identity-Adapter und externen Signer-Pfad einschließlich Konto-/Sessionbindung.
- Kompatibilitätsadapter zwischen bestehendem TCG-Backup und aktuellem Hangar; persistenter Relay-/Blossom-Service mit Berechtigungen.
- Vollständige Figur-/Stein-Provisionierung und Wiederherstellung auf einem zweiten Gerät gegen den vorgesehenen Locker. Der geprüfte Unlock-Code allein belegt dessen Produktionstauglichkeit nicht.
- Geschützter lokaler Wallet-Speicher: Das TCG-Backup verschlüsselt den Remote-Snapshot, der vorhandene lokale Wallet-Zustand enthält weiterhin Secrets in localStorage.
- Geprüfter Geräteübergabe- und Crash-Recovery-Ablauf; Schutz vor veralteten Snapshots und weiter ausgebbaren Token-Kopien.
- Reale Interoperabilitätsprobe mit Nappelin-Signer, TCG-Snapshot, Relay, Blossom und anschließendem Restore auf einem zweiten Gerät.

Envelope/Hashtree sind keine Lösung für diese Identity- und Writer-Lücken. Ihre zusätzliche Einbindung ist für das bestehende verschlüsselte Snapshot-Verfahren nicht Voraussetzung. Granola/Monero/USDT bleibt V2.

## Reproduzierte Tests und Grenzen

```powershell
node --test G:/Github/nappelin.com/apps/hangar/test/identity.test.mjs G:/Github/nappelin.com/apps/hangar/test/locker.test.mjs G:/Github/nappelin.com/apps/hangar/test/login-lifecycle.test.mjs
```

Ergebnis: **27 bestanden, 0 fehlgeschlagen**. Enthält echte lokale Kryptografie und Locker-Testvektoren; Locker-Anfragen und Browser-Lifecycle werden simuliert. Zusätzlich **6 TCG-Wallet-Sync-Tests bestanden**, mit simuliertem Signer/Relay/Blossom. Das ist kein Live-End-to-End-Nachweis der Verbindung.

Logs: `outputs/feasibility-2026-09-09/nappelin-identity-tests.log` und `tcg-wallet-sync.log` im Bearlett-Repository. Entscheidungen vor Erstellung dieses Berichts in `audit.sqlite` erfasst.

## Primäre Codebelege

- `G:/Github/nappelin.com/apps/hangar/src/identity/{types,keyholder,object-code,locker-core,extension,worker,worker-client,slot}.ts`
- `G:/Github/nappelin.com/apps/hangar/src/{host,login}.ts`
- `G:/Github/nappelin.com/services/agent-api/scripts/mint-identity.mjs`
- `G:/Github/TCG600nap/site/{napplet,nostr-wallet-sync,nutft-wallet}.js`

Infografik: `nappelin-wallet-v1-infographic-2026-09-09.png`, erzeugt mit dem eingebauten ImageGen-Werkzeug. Prompt: `nappelin-wallet-v1-infographic-prompt.txt`. Die Grafik ist ein Architekturentwurf; die Original-SVGs im Nappelin-Repository bleiben die verbindlichen Logo-Assets.

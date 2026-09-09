# Bestehende TCG-Wallet: Korrektur des Projektinventars

Auf Hinweis des Nutzers zusätzlich geprüft: `G:\Github\TCG600nap`, Branch
`feature/g-mint-live`, Commit `d7535057480d3a16fcb6878eba78d70c66951fc5`.
Das Repository wurde ausschließlich gelesen; bestehende Änderungen bleiben erhalten.

**Die verschlüsselte Blossom-Wallet-Anbindung existiert bereits.** Frühere
Aussagen, sie müsse erst gebaut werden, bezogen sich auf den Bearlett-Checkout
und waren für den Gesamtbestand unvollständig. Der nächste Schritt ist der
Abgleich und die Wiederverwendung des vorhandenen Adapters, kein Neubau auf
Basis einer vermeintlich fehlenden Speicherlösung.

## Im Code bestätigt

- `site/nutft-wallet.js`: NutFT-Wallet mit privaten P2BK-Schlüsseln, Tokenbestand,
  vorbereiteten Outputs, Pending-Operationen, wiederauffindbaren ausgehenden
  Transfers sowie Export/Restore. Unterstützte Keyset-Einheiten `600B-E1` und
  `600B-G`; eigene `/nutft/booster`- und `/nutft/trade`-Protokolle.
- `site/nostr-wallet-sync.js:317`: NIP-44-Verschlüsselung über den Signer,
  komprimierte Snapshots und begrenzte Chunkzahl.
- `site/nostr-wallet-sync.js:414`: große Ciphertexts auf
  `https://blossom.bimcvp.com`; signierte Upload-Autorisierung, Größen-/Hashprüfung
  und erneuter Download vor Veröffentlichung des Zeigers.
- `site/nostr-wallet-sync.js:469`: kleine verschlüsselte Snapshots direkt auf
  `wss://relay.bimcvp.com`, große über Blossom-Zeiger. Eigener Event-Kind 37378,
  Revision und signierte Vorgängerkette; sichtbare konkurrierende Zweige werden
  abgelehnt, nicht automatisch zusammengeführt.
- `site/nutft-wallet.js:854`: Backup-Ersetzung vergleicht den aktuellen Stand mit
  dem vor dem Netzwerkzugriff gelesenen Stand und verweigert Überschreiben bei
  Änderung; Web Locks schützen die Operation, soweit verfügbar.
- `site/napplet.js`: NIP-44-Provider über Shell oder externen Nostr-Signer.

Sechs Tests aus `tests/js/wallet-sync.test.mjs` wurden erneut ausgeführt und
bestanden, einschließlich großer Blossom-Snapshots, neuem Gerät, Fork und
abweichender nichtleerer Zielwallet. Signer/Krypto, Relay, Blossom und Teile des
Wallet-Adapters sind dabei simuliert. Das ist ein Beleg für die getestete
Koordinationslogik, kein neuer Live-/Android-/NIP-44-Interop-Nachweis.

```powershell
node --test G:/Github/TCG600nap/tests/js/wallet-sync.test.mjs
```

Rohprotokoll im Bearlett-Arbeitsverzeichnis:
`outputs/feasibility-2026-09-09/tcg-wallet-sync.log`.

## Konsequenz für V1

Die vorhandene TCG-Speicher-/Sync-Lösung ist der konkrete Ausgangspunkt für
einen Bearlett-Adapter. Hashtree und Envelope sind mögliche zusätzliche
Funktionen, keine Voraussetzungen dafür, überhaupt verschlüsselte Backups
auf Blossom zu speichern.

Die Protokollkerne bleiben fachlich verschieden: NutFT-Karten mit CardBinding
und P2BK sind nicht dieselben Assets wie Bearletts ungebundene Cashu-Sats oder
LNURLcash. Wiederverwendung bedeutet zuerst versionierte Schnittstellen und
vollständige Bearlett-Journale im Snapshot, nicht blindes Zusammenführen beider
Walletzustände oder Ersetzen des vorgeschriebenen First-Party-NutFT-Mints.

Noch zu bewerten sind insbesondere:

- Die lokale NutFT-Wallet speichert private Schlüssel und Tokens als JSON in
  localStorage. Verschlüsselte entfernte Snapshots sind bereits vorhanden;
  geschützte lokale Verwahrung ist eine separate Eigenschaft.
- Fork-Erkennung verhindert kein gleichzeitiges Ausgeben auf zwei Geräten.
  Der ausdrücklich gewählte Gerätewechsel mit einem Schreiber bleibt nötig.
- Es gibt einen fest konfigurierten Relay und Blossom-Server; Spiegelung ist
  nicht implementiert. Die vollständige Historie ist auf 500 Events begrenzt
  und verweigert dann Sync statt einen Head zu raten.
- Die sechs Sync-Tests ersetzen keine Prüfung sämtlicher Wallet-Operationen,
  fehlgeschlagener Storage-Zugriffe oder echter Signer-/Gerätewechsel.

## Bestätigte Umfangsentscheidung

**Granola gehört zu V2.** Granola-HTLC-Märkte und die darüber gewünschten
XMR-/USDT-Swaps werden aus V1 herausgenommen. Ihre Existenz ist kein
Freigabekriterium und keine Infrastrukturvoraussetzung für V1.

V1 konzentriert sich auf die vorhandenen Wallets, sichere LNURLcash-/Cashu-
Operationen, Wiederherstellung und expliziten Gerätewechsel. Der ursprüngliche
Bearlett-Fehlerbericht F00–F04 bleibt für dessen geprüften Code gültig; er darf
nicht ungeprüft auf die separate NutFT-Wallet übertragen werden.

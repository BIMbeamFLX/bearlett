# Bearer-Token auf Blossom mit Hashtree und Envelope

Ergänzung zur [Architektur](ARCHITECTURE-2026-09-09.md), 9. September 2026.
Anlass: ausdrücklich gewünschte Speicherung der Bearer-Token selbst in
verschlüsselten Blossom-Blobs, mit Envelope als Zugang. Empfehlung und
Quellenprüfung, noch keine implementierte oder getestete Storage-Anbindung.
Die Entscheidung wurde vor diesem Dokument in der SQLite-Prüfakte erfasst.

**Bestandskorrektur:** Die später vom Nutzer genannte TCG-Wallet besitzt bereits
eine verschlüsselte Blossom-Anbindung. Die folgenden neuen Arbeiten betreffen
Hashtree/Envelope und die Bearlett-Integration; den Speicheradapter nicht neu
erfinden. Siehe [geprüfter vorhandener Stand](TCG-WALLET-2026-09-09.md).

## Einschätzung

**Ja, verschlüsselte Token lassen sich so speichern.** Blossom ist dafür ein
plausibler Speicher für unveränderliche verschlüsselte Objekte. Hashtree kann
mehrere Token, Metadaten und Artwork unter einem prüfbaren Root organisieren.
Envelope kann die passende Wallet mit einem Import-/Restore-Verweis öffnen.
Keine dieser Komponenten ersetzt den lokalen Transaktionsspeicher, das
Wallet-Journal oder die Prüfung und Rotation beim Mint.

Blossom speichert beliebige Bytes unter deren SHA-256-Hash. Es verschlüsselt
sie nicht zwangsläufig selbst. Der konkret verlinkte Hashtree-Entwurf ist
standardmäßig unverschlüsselt und bietet zwei optionale Verschlüsselungssuiten.
Für Bearer-Token würden wir Verschlüsselung verbindlich verlangen.

## Tatsächlich gelesene Quellen

Die Gitworkshop-Seiten wurden im Browser vollständig gelesen, nachdem der
HTTP-Abruf lediglich die leere SPA-Hülle geliefert hatte. Angezeigter Commit:
`ad5c1af0dd84749c97a6dd95332527dc586806bc`, Branch `hashtree`.

- [README](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/README.md):
  experimentelles clientseitiges Protokoll, ausdrücklich kein offizieller BUD;
  Manifestbäume, optionale Verschlüsselung, experimentelle `htree`-/`nhash`-
  Kennungen und Nostr-Kind 30064.
- [Verschlüsselung](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/hashtree-encryption.md):
  `chk-v1` leitet den Schlüssel aus dem Klartext ab und ermöglicht Deduplizierung;
  `rnd-v1` verwendet zufälligen Schlüssel und Nonce. Beide verwenden AES-GCM.
  Die 33-Byte-Schlüssel enthalten ein Versions-/Suite-Byte. Ein solcher Schlüssel
  ist selbst ein Bearer-Secret und darf nicht an Blossom gesendet werden.
- [Referenzen](https://gitworkshop.dev/hzrd149.com/git.shakespeare.diy/blossom/tree/hashtree/implementations/hashtree/hashtree-references.md):
  unveränderliche Roots über `nhash`, veränderliche Roots über Kind 30064.
  `owner-private` verschlüsselt den Root-Key mit NIP-44 an den eigenen Nostr-Key.
  `link-private` verteilt Zugang über einen geheimen Link. Ein verschlüsselter
  `public`-Root veröffentlicht dagegen den Schlüssel: für Wallet-Privatsphäre
  ungeeignet. Ereignisse verraten weiterhin Autor, Baumname, Zeit und Root-Hash.
- [Envelope](https://github.com/brenorb/envelope/tree/7d7ff1cf509f39ffe159c1cee7c93ba8ba042fd5):
  Remote-HEAD erneut geprüft, unverändert. `src/fragment.js` unterstützt offene
  und passwortverschlüsselte Launch-Fragmente; Zustand maximal 4.096 Bytes,
  gesamtes Fragment maximal 8.192 Zeichen. `scripts/build-paja-runtime.mjs`
  löst `blossom:sha256:<hash>` über einen Blossom-Server auf. Das ist kein
  Hashtree-Resolver, Upload-/Vault-Dienst oder Wallet-Restore-Protokoll.

Die Hashtree-Texte definieren bewusst überarbeitete Formate gegenüber den
ursprünglichen PRs 104–107. Kompatibilität mit einer beliebigen vorhandenen
Hashtree-Bibliothek oder mmalmis aktuellem Client ist damit nicht belegt.
Die dort verlinkte Implementierung wurde in diesem Nachtrag nicht getestet.

## Vorgeschlagene Aufteilung

| Zweck                        | Ausgestaltung                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privates Wallet-Backup       | Verschlüsselte Token **plus** vollständige Counter, vorbereitete Outputs und Journale; privater Root, Zugriff über eigenen Wallet-Nostr-Key                |
| Einzelnen Schein weitergeben | Separates verschlüsseltes Paket nur für diesen Transfer; eigener Schlüssel und unveränderlicher Root; niemals Zugriff auf das gesamte Wallet-Backup teilen |
| Envelope-Link/QR             | Startet verifiziertes Wallet mit definiertem Receive-/Restore-Verweis. Wallet prüft den Auftrag und fordert Entsperrung/Bestätigung an.                    |
| Lokaler aktiver Zustand      | Weiterhin atomarer Store und genau ein Writer; Blossom dient der entfernten Speicherung und Übertragung                                                    |

Für geheime Walletdaten ist `rnd-v1` der bevorzugte Prüfkandidat: keine
inhaltlich deterministischen Ciphertexts und weniger Gleichheitsinformation
als bei CHK. Metadaten und Schlüssel tragende Elternmanifeste müssen ebenfalls
verschlüsselt sein. Ein verschlüsseltes Kind mit offenem Schlüssel im öffentlichen
Elternmanifest ist nicht privat. Hash, Suite und Schlüsselzuordnung müssen durch
den authentifizierten Root/Backup-Commit gebunden werden.

Der Speicherablauf lautet: lokal konsistent committen, verschlüsselte Objekte
hochladen, alle benötigten Objekte vom Speicher zurücklesen und prüfen, dann
den vollständigen Root veröffentlichen. Ein Root darf nicht als erfolgreiches
Backup gelten, solange erforderliche Kinder fehlen. Zwei unabhängige Speicher
und ein Dateibackup erhöhen Verfügbarkeit; Aufbewahrung/Quoten müssen geprüft
werden. Für kleine Backups kann ein einzelner verschlüsselter Blossom-Blob
zunächst einfacher sein als ein kompletter Baum.

Kind 30064 mit `owner-private` ist eine konkrete Alternative zum zuvor
vorgeschlagenen NIP-78-Backup-Container. Die endgültige Auswahl bleibt vom
Interop-Spike abhängig. Es soll nicht zwei konkurrierende Quellen für den
neuesten Walletstand geben. Auch ein gültig signierter Hashtree-Root liefert
keinen verteilten Writer-Lock und garantiert auf einem neuen Gerät nicht, dass
ein Relay keine neueren Roots unterschlägt. Expliziter Gerätewechsel bleibt.

## Bearer-Übergabe und Verwahrung unterscheiden

Ein Empfänger mit Blobzugang und Schlüssel kann den enthaltenen ungebundenen
Token ausgeben. Wenn der Schlüssel im weitergegebenen Link steckt, ist **der
Link selbst** ein Geldschein. Wer eine Kopie hat, kann um die Einlösung konkurrieren.
Speichern, Kopieren und Löschen auf Blossom beweisen keinen Eigentumswechsel.

Empfang daher mit Mint-Prüfung und Rotation in neue, nur dem Empfänger bekannte
Secrets. Cashu über den entsprechenden Swap, LNURLcash über Rotation. Eine
unverändert gelesene Kopie ist noch kein sicher übernommenes Guthaben. Einmalige
Einlösung wird beim Mint durchgesetzt, nicht durch Einmal-Download oder Blob-Löschung.

Envelope entschlüsselt sein optionales `nwe1`-Fragment derzeit im Opener und
gibt den Zustand per Intent weiter. Für unsere Host-Vertrauensgrenze sollte es
nur einen nicht spendbaren Verweis tragen; Entschlüsselung im vertrauenswürdigen
Wallet-Kontext. Ein absichtlich als Bearer-Link gestalteter Transfer braucht
eine gesonderte, explizite Behandlung dieses Secrets. Keine Vault-Schlüssel
oder Token in Analyse-Logs, öffentliche Root-Tags oder HTTP-Gateway-URLs kopieren.

## Begrenzter nächster Nachweis

1. Gewählte Clientversion gegen genau diese Hashtree-Fassung und ihre Vektoren
   prüfen, insbesondere `rnd-v1`, private Roots und `nhash`-Format.
2. Ein synthetisches Tokenpaket lokal verschlüsseln, auf zwei isolierten
   Blossom-Testservern speichern und mit einer frischen Wallet wieder lesen.
3. Falscher Schlüssel, manipuliertes Kind, fehlender Blob, alter Root,
   Serverausfall und Upload-Abbruch müssen erkannt werden.
4. Envelope startet den geprüften Receive-Vertrag mit einem Verweis; Testmint
   rotiert den Token. Zweite Einlösung derselben Übergabe scheitert am Mint.
5. Backup enthält auch Pending-Journal/Counter; Prozesskill, Restore und
   Gerätewechsel bestehen ohne doppelte Zahlung.

Dieser Nachtrag enthält keine Uploads, keine echten Token und keine Änderung
am Wallet-Kern. Die zuvor reproduzierten F00–F04 bleiben zu beheben; ein neuer
entfernter Speicher beseitigt diese lokalen Fehler nicht.

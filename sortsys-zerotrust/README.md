# Verschlüsselte Daten im Browser

Dieses Paket enthält die Client-Grundlage des Entwurfs auf `draft/zerotrust`.
Ein Betrieb soll beispielsweise Kalkulationspreise getrennt von Leistungstexten
freigeben können. Die API erhält verschlüsselte Inhalte und öffentliche
Berechtigungsnachweise; sie bekommt weder Daten- noch Recovery-Schlüssel.

Die Webapp enthält OPAQUE-Anmeldung, lokalen Schlüsselspeicher und die
Wiederherstellungsoberfläche. Nach dem Einrichten der Mandantenschlüssel sperrt
die API die bisherigen Fachdatenzugriffe. Der Browser sichert den vorhandenen
Tabellenbestand anschließend automatisch verschlüsselt und setzt eine
unterbrochene Übertragung beim nächsten Versuch fort. Auch nach einer Wiederherstellung bleiben die bereits
gesicherten Teile lesbar. Eine lokale DuckDB-Prüfung entschlüsselt das Archiv
und prüft Datentypen und Verweise über den gesamten Bestand.

**Die Bestandsumstellung ist noch nicht vollständig.** Das Zwischenarchiv ist
für die Administration bestimmt. Es ersetzt weder die einzelnen Fachabläufe
noch deren abgestufte Freigaben. Die bisherigen Klartexttabellen und Dateien
werden in diesem Schritt noch nicht gelöscht; der Betreiber kann sie deshalb
weiterhin lesen. Der Mandant bleibt bis zur vollständigen Umstellung gesperrt.

Der bisherige technische Stand umfasst:

- OPAQUE-Anmeldung mit Argon2id und verschlüsseltem Kontospeicher;
- signierte Identitäten und Freigaben, getrennte Schlüssel je Inhaltsbereich;
- AES-GCM-Datenblöcke mit eigenen Datenschlüsseln und HPKE-Schlüsselpakete;
- Recovery mit einer ausschließlich clientseitigen 24-Wort-Phrase, neuer Phrase
  und neuen Schlüsseln nach jedem Wechsel;
- Inhaltsprüfung im Client: Fehlerhafte Änderungen ersetzen keinen bereits
  geprüften Stand. Eine Signatur ersetzt keine fachliche Prüfung.

Die Rust-API ergänzt dafür `auth.opaque.*` und `zerotrust.*`. PostgreSQL sichert
Versionen und Generationen über Transaktionen und Zeilensperren. Ein Test mit
zwei unabhängigen API-Instanzen unterbricht Recovery zwischen Master- und
Mandantenänderung und setzt denselben signierten Plan über die andere Instanz fort.
Die API prüft dabei zu keinem Zeitpunkt entschlüsselte Geschäftsdaten.

Benutzerfreigaben, lokale Katalog- und Adresssuche sowie verschlüsselte
Projektdateien sind inzwischen in die Webapp eingebunden. Produkt- und
Lieferantenlöschungen verwenden signierte öffentliche Beziehungen, ohne Preise
zu entschlüsseln. Office-Dateien öffnen die angebundenen CryptPad-Browsereditoren.
Chat und Einlesen verwenden die begrenzte Live-Ausnahme mit authentifiziertem MCP.
Weitere Fachbereiche, der vollständige Suchvergleich, verschlüsselte gemeinsame
GAEB-Updates und die abschließende Bereinigung der Klartextbestände fehlen noch.
Der [Funktionsabgleich](../docs/verschluesselung-funktionsabgleich.md) hält die
angeschlossenen Abläufe und die verbleibenden Unterschiede fest.

## Prüfen und weiterentwickeln

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

OPAQUEs Passwortableitung gehört in einen Browser-Worker. Private Schlüssel,
Seed-Phrasen und entschlüsselte Suchindizes dürfen nicht unverschlüsselt in
`localStorage`, IndexedDB oder Protokollen landen. Die Bibliothek führt keine
automatische Speicherung dieser Geheimnisse aus.

Die Dateien unter `rust-api/tests/fixtures/zerotrust-*.json` in der API enthalten
öffentliche synthetische Protokollbeispiele. Nach einer bewussten Änderung des
Recovery-Protokolls erzeugt `bun test/generateRecoveryVector.ts` den dazugehörigen
Testvektor neu. Die dortigen Zugangsdaten sind ausschließlich für Tests bestimmt.

Der [Architekturentwurf](../docs/verschluesselung-und-berechtigungen.md), die
[Recovery-Beschreibung](../docs/mandanten-wiederherstellung.md) und die
[Grenzen der Datenprüfung](../docs/verschluesselung-datenpruefung.md) gehören zur
Bewertung dieses Entwurfs. Eine externe kryptografische Prüfung steht aus.

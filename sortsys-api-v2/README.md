# sortsys API

Die Rust-API speichert Daten getrennt je Mandant und synchronisiert gemeinsam
bearbeitete Dokumente. Der TypeScript-Client stellt typisierte Aufrufe bereit.
API und Client implementieren das gebündelte RPC-Protokoll direkt und benötigen
zur Laufzeit kein tRPC.

## Aufbau

- [`rust-api`](rust-api/README.md): Axum-Dienst, PostgreSQL-Migrationen, Prozeduren, WebSocket-Anbindung der Hintergrunddienste, WebAuthn, Speicher, Sicherungen und Beispieldaten.
- [`client`](client/README.md): erzeugte Prozedurtypen und RPC-Client für den Browser.
- [`scripts`](scripts): Werkzeuge für Mandanten und Datenübernahme.
- [`test-files`](test-files): Beispieldateien für Integrationstests.

## Entwicklung

Die vollständige Umgebung samt Diensten und Beispielmandant im Hauptverzeichnis starten:

```bash
./scripts/dev
```

Die folgenden Rust-Befehle aus `sortsys-api-v2` ausführen. Die Toolchain steht
in der [CI](../.github/workflows/ci.yml):

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Die Integrationsprüfung verwendet echte PostgreSQL- und S3-kompatible Dienste:

```bash
../scripts/test-api
```

## Aktualisierungen mit bestehenden Daten prüfen

Migrationen gegen einen vorhandenen Stand mit temporären PostgreSQL- und
S3-Diensten prüfen; dazu im Hauptverzeichnis ausführen:

```bash
git fetch origin deploy
./scripts/test-deploy-upgrade "$(git rev-parse origin/deploy)"
```

Das Werkzeug befüllt die archivierten Deploy-Quellen mit Beispieldaten, erhält
diese Daten und startet den Kandidaten. Anschließend prüft es Datenerhalt,
Migrationen und API-Schreibzugriffe. Beabsichtigte Transformationen benötigen
explizite Erwartungen in `rust-api/tests/upgrade_scenarios.rs`.
Diese lokale Zusatzprüfung ist optional; die [CI-Übernahme](../.github/BRANCHES.md)
hängt von den regulären Repository-Tests ab.

## Skalierung und Zusammenarbeit

Mehrere API-Instanzen teilen Master- und Mandantendatenbanken, Objektspeicher
sowie Signatur- und Verschlüsselungsgeheimnisse. Master-Initialisierung und
Mandantenmigrationen verwenden transaktionsgebundene Advisory Locks.
Native Dokumente werden mit Zeilensperren und exakten Revisionen gespeichert;
PostgreSQL koordiniert Rechnungszähler und befristete Auftragszuweisungen.

Für GAEB arbeiten Yjs/yrs, ein mandanteneigenes Änderungsprotokoll und LISTEN/NOTIFY
zusammen. Zwischenstände begrenzen den Wiederholungsaufwand. Ablaufende
Anwesenheitseinträge und Sitzungskennungen ermöglichen die Wiederverbindung ohne
doppelte Ausgangstexte. Dokument- und Vorgangsbenachrichtigungen werden mit den
Datenbankänderungen bestätigt. Lesen, Bearbeiten, Berechnen, Validieren und Drucken
bleiben clientseitig.

GAEB benötigt weder feste Client-Zuordnung zu einer API-Instanz noch einen eigenen
Dokumentenserver. Der Load Balancer muss WebSocket-Upgrades und mindestens
90 Sekunden Leerlauf erlauben. Pro aktivem Mandanten und Instanz gibt es eine
zusätzliche Listener-Verbindung, die nach einer Minute ohne Nutzung freigegeben
wird. Dafür sind PostgreSQL-Sitzungsverbindungen erforderlich; reine
Transaktions-Pooler reichen nicht aus. Fachliche Zugriffe nutzen begrenzte Pools.
Die Integrationssuite prüft unabhängige Instanzen, Wiederverbindungen,
gleichzeitige Schreibzugriffe und Migrationen.

## Erzeugte API-Typen

Prozedurnamen sowie Ein- und Ausgabetypen entstehen aus der Rust-Registrierung:

```bash
cargo run --package sortsys-api --bin generate_contract
cargo run --package sortsys-api --bin generate_contract -- --check
```

Anschließend den Client bauen:

```bash
cd client
bun install --frozen-lockfile
bun run build
```

## Laufzeitkonfiguration

| Variable | Erforderlich | Bedeutung |
| --- | --- | --- |
| `PG_MASTER_DSN` | ja | PostgreSQL-Verbindung zur Masterdatenbank |
| `JWT_SECRET` | ja | Signaturgeheimnis für Sitzungen |
| `ADMIN_HASH` | ja | bcrypt-Passworthash des globalen Administrators |
| `JOB_RUNNER_TOKEN` | produktiv | gemeinsames Geheimnis für WebSocket-Verbindungen der Hintergrunddienste |
| `LLM_ENCRYPTION_KEY` | für LLM-Einrichtung | Verschlüsselung der Anbieter-API-Schlüssel in der Masterdatenbank |
| `LLM_MCP_URL` | für natives MCP | vom Anbieter erreichbare URL; für OpenRouter optional |
| `ONLYOFFICE_PUBLIC_URL` | für Office-Bearbeitung | im Browser erreichbare Dokumentenserver-Adresse |
| `ONLYOFFICE_INTERNAL_URL` | nein | Adresse für API-Zugriffe auf den Dokumentenserver; standardmäßig die öffentliche Adresse |
| `ONLYOFFICE_CALLBACK_URL` | für Office-Bearbeitung | vom Dokumentenserver erreichbare API-Rückrufadresse |
| `ONLYOFFICE_JWT_SECRET` | für Office-Bearbeitung | gemeinsames JWT-Geheimnis von API und Dokumentenserver |
| `DRAWIO_PUBLIC_URL` | für Diagramme | Browseradresse von diagrams.net, auch als gleichursprünglicher Pfad wie `/drawio` |
| `AUTO_BACKUPS_ENABLED` | nein | tägliche Datenbanksicherungen; standardmäßig `true` |
| `PORT` | nein | HTTP-Port, standardmäßig `3000` |
| `NODE_ENV` | nein | `production` aktiviert die Produktivanforderungen |

Außer `PORT` und `NODE_ENV` lassen sich diese Werte auch als Dateien unter
`/run/secrets/SORTSYS_API_V2_<NAME>` bereitstellen. Umgebungsvariablen haben Vorrang.

### LLM-Anbindung

Chat und Dokumenteinlesen unterstützen OpenAI und Anthropic über deren native
MCP-Konnektoren. OpenRouter verwendet eine MCP-Brücke in der Anwendung: Sie
ermittelt Werkzeuge, übergibt deren Schemata als Funktionswerkzeuge und führt
Aufrufe über authentifiziertes MCP aus. Chatberechtigungen, Bestätigung von
Vorschlägen und die Beschränkung des Dokumenteinlesens auf den Produktkatalog
bleiben erhalten. Fehler bei OpenAI oder Anthropic lösen keinen Wechsel auf
OpenRouter aus.

Für OpenAI und Anthropic muss `LLM_MCP_URL` als HTTPS-Adresse vom Anbieter
erreichbar sein, etwa `https://sortsys.example/api/v2/internal/llm/mcp`.
OpenRouter nutzt standardmäßig authentifiziertes HTTP-MCP unter
`http://127.0.0.1:<PORT>/internal/llm/mcp` und braucht keinen öffentlichen Eingang.
Ein explizites `LLM_MCP_URL` überschreibt diese Vorgabe; die API muss die Adresse
erreichen können, auch in privaten Netzen.

OpenRouter-Modell und Endpunkt müssen Werkzeuge unterstützen, zum Einlesen
zusätzlich strukturierte Ausgaben und angehängte Bilder. Nicht unterstützte
Parameter führen zu Fehlern. Andere Anbieterkonten können gespeichert bleiben,
lassen sich diesen Anwendungsfällen aber nicht zuweisen.

## Dokumentzugriff über MCP

Der Chat bietet `sortsys_search_documents` und `sortsys_read_document`. Beide
verwenden den Mandanten und die aktuellen Projektdatei-Berechtigungen des
angemeldeten Benutzers. Die Suche nutzt den Volltextindex der Dokumentansicht
und liefert Auszüge und Vorschaulinks. Das Lesewerkzeug liefert Unicode-Text
in begrenzten Abschnitten. Bei Folgeabrufen den Wert `revision` mitgeben, damit
zwischenzeitliche Änderungen erkannt werden. Speicherzugänge, Objektschlüssel und signierte
Download-Adressen werden nicht ausgegeben.

Die Texterkennung unterstützt derzeit PDF-Text und OCR gescannter PDFs. Andere
Dateien bleiben nach Namen suchbar. Ausstehende, fehlgeschlagene, nicht unterstützte
oder veraltete Erkennung wird ausdrücklich gemeldet. Der Dokumenteinlese-MCP
bleibt auf den Produktkatalog begrenzt. Dokumentinhalte und Auszüge sind nicht
vertrauenswürdige Daten und keine Anweisungen an den Assistenten.

## Automatische Datenbanksicherungen

Die API prüft beim Start und minütlich auf fällige Sicherungen. Verwaltete
Datenbanken auf dafür aktivierten Hosts werden täglich um 02:00 Uhr in
`Europe/Berlin` gesichert. Die Aufbewahrung wird getrennt für tägliche, wöchentliche,
monatliche und jährliche Sicherungen eingestellt. Mindestens einer dieser Werte
muss größer als null sein. Es gelten die Speichereinstellungen des Hosts.

Beim Wechsel zur Sommerzeit wird die fehlende 02:00-Uhr-Ausführung um 03:00 Uhr
nachgeholt. Bei der Rückstellung zählt das erste Auftreten von 02:00 Uhr.
Erfolgreiche Läufe werden getrennt von aufbewahrten Sicherungsdateien vermerkt,
damit Bereinigung und Neustarts keine Doppelungen auslösen. Advisory Locks
koordinieren mehrere API-Instanzen und manuelle Sicherungen.

Überfällige Sicherungen werden nach dem Start nachgeholt, Fehler nach 15 Minuten
erneut versucht. Automatische Läufe sind auf sechs Stunden begrenzt. Schlägt die
Sicherung einer Datenbank fehl, laufen die übrigen Sicherungen weiter. Temporäre Dump-Verzeichnisse
sind nur für ihren Eigentümer zugänglich und werden bei Abbruch entfernt.

`AUTO_BACKUPS_ENABLED=false` deaktiviert die Hintergrundplanung; manuelle
Sicherungen bleiben verfügbar. Beim Herunterfahren beendet die API die aktuelle
Sicherung und startet keine weitere.

## Sichtbarkeit von Änderungen

Ereignisse speichern die Namen geänderter Spalten, keine Kopien ihrer Werte.
Die Oberfläche beschriftet sie deutsch oder englisch. Projektabschluss und
Wiederaufnahme sind eigene Aktionen und werden nicht aus dem aktuellen Zustand
abgeleitet. Ein protokolliertes Ereignis gewährt keinen Zugriff: Vor Gruppierung
und Seiteneinteilung gelten die aktuellen Rollen und Beziehungen.

- Projekthistorie erfordert `view:projects` oder eine aktuelle Projektzuordnung. Nach deren Entzug sind auch alte Ereignisse nicht mehr zugänglich.
- Lieferscheine und Berichte benötigen eigene Leserechte sowie Zugriff auf das Projekt. Eine Projektzuordnung allein reicht nicht.
- Finanzereignisse verlangen `view:projects`, `view:deliveryNotes` und `view:dailyProjectReports` wie die Projektkostenabfrage.
- Einsätze erfordern Planungszugriff oder müssen die lesende Person selbst betreffen. Inventur und Produktpreise verwenden ihre eigenen Leserechte.
- Werkzeugbuchungen und Übergaben sind für Beteiligte oder mit `view:toolTrackings` sichtbar. Privater Projektkontext bleibt verborgen.
- Benutzer sehen ihre eigenen Profil- und Berechtigungsänderungen. Fremde Berechtigungen verlangen Mandantenadministration, Passwortänderungen Administration oder Eigentümerschaft. Passkey-Historie sieht nur der Eigentümer.
- Urlaubshistorie ist für den Mitarbeiter, direkte und indirekte Vorgesetzte sowie passende Urlaubs- oder Planungsrollen sichtbar. `view:users` allein genügt nicht.
- Weitere Objekte folgen ihren Leserechten. Mandantendatenbanken trennen die Mandanten; eine Akteur-ID ordnet eine Handlung zu und ist keine Zugriffsfreigabe.

Gelöschte Objekte bleiben nach denselben aktuellen Zugriffsprüfungen in der
Historie. Das Dashboard zeigt das neueste sichtbare Ereignis je Objekt, der
Verlauf alle Ereignisse. Seed-Schreibzugriffe sind als Beispieldaten markiert.

## Container-Image

Produktives API-Image aus diesem Verzeichnis bauen:

```bash
docker build -t sortsys-api:local .
```

Das Image enthält PostgreSQL-17-Werkzeuge, da Sicherung und Wiederherstellung
`pg_dump` und `psql` ausführen.

## Lizenz

Für diesen Workspace gilt die [GNU Affero General Public License v3.0 only](LICENSE).

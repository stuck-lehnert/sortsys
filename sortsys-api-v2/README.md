# sortsys API

Die Rust-API speichert verschlüsselte Daten und öffentliche Zugriffsnachweise.
Angebote, Preise, Aufmaße und andere Geschäftsinhalte werden im Browser geprüft
und bearbeitet. Alle API-Instanzen verwenden denselben DuckDB-Datendienst;
nur dieser öffnet die Mandantendateien.

## Aufbau

Der Einstieg in [`main.rs`](rust-api/src/main.rs) verwendet
[`standalone.rs`](rust-api/src/standalone.rs). Dieser Router registriert
Anmeldung, Ersteinrichtung, Einladungen, Schlüsselverwaltung und die
verschlüsselten Speicherprotokolle. Der Quelltext enthält keine früheren
SQL-Prozeduren, PostgreSQL-Migrationen oder Klartext-Hintergrundjobs.
Der [Funktionsabgleich](../docs/verschluesselung-funktionsabgleich.md) nennt
die offenen Punkte der Anwendung. Die [Bestandsübernahme](../docs/bestandsumstellung.md)
beschreibt den optionalen Backupweg bei der Ersteinrichtung.

[`sortsys-zerotrust`](../sortsys-zerotrust/README.md) stellt die gemeinsamen
Kryptografiebausteine für Rust und TypeScript bereit. Der [TypeScript-Client](client/README.md)
implementiert das gebündelte RPC-Protokoll. Viele typisierte Geschäftsoperationen
werden durch die Datenadapter der Webapp lokal ausgeführt; ihre Typen bedeuten
keine Registrierung eines Klartext-Endpunkts am Server.
Ihre Vertragsmodelle liegen in `rust-api/src/contracts/`; die Betreiberverwaltung
verwendet die eigenen Handler in `rust-api/src/operator.rs`.

## Entwicklung und Prüfungen

Die lokale Umgebung startet im Hauptverzeichnis mit `./scripts/dev`.
[Konfiguration, Datenverzeichnisse und Protokolle](../docs/development.md) stehen
im Entwicklungsleitfaden.

Aus `sortsys-api-v2` mit der festgelegten Rust-Toolchain und
[DuckDB-Bibliothek](rust-api/duckdb/README.md#entwicklung-und-prüfungen):

```bash
cargo fmt --all --check
cargo test --workspace --lib
cargo clippy --workspace --all-targets -- -D warnings
cargo run --bin generate_contract -- --check
```

`../scripts/test-native-auth` startet einen eigenen DuckDB-Dienst und unabhängige
API-Instanzen. Der Test verwendet denselben Router wie der ausführbare Server
und den tatsächlichen Webapp-Code für Anmeldung, Freigaben und Recovery.
Er benötigt Rust, Bun und die festgelegten DuckDB-Erweiterungen.

`../scripts/test-api` stellt diese Werkzeuge in einem eigenen Docker- oder
Podman-Container bereit. Es prüft außerdem die Rust-Pakete, den TypeScript-Client
und den erzeugten Vertrag. Der Testcontainer veröffentlicht keine Ports, liest
keine lokalen Zugangsdaten und wird anschließend entfernt. Es werden weder der
Entwicklungsstack noch alte PostgreSQL-Instanzen verwendet. Protokolle bleiben
unter dem ausgegebenen Pfad erhalten; `TEST_LOG_DIR` legt einen eigenen Pfad fest.

## Laufzeitkonfiguration

| Variable | Bedeutung |
| --- | --- |
| `JWT_SECRET` | Signaturgeheimnis für Sitzungen, mindestens 32 Bytes |
| `ADMIN_HASH` | bcrypt-Hash für die Betreiberverwaltung |
| `DUCKDB_QUACK_URI` | interner Quack-Endpunkt des gemeinsamen Datendienstes |
| `DUCKDB_CONTROL_URL` | interner HTTP-Endpunkt desselben Datendienstes |
| `DUCKDB_SERVICE_TOKEN` | technische Anmeldung am Datendienst, kein Entschlüsselungsschlüssel |
| `PORT` | optionaler HTTP-Port, standardmäßig `3000` |

Die API-Einstellungen können unter `/run/secrets/SORTSYS_API_V2_<NAME>` liegen,
die Datendienstwerte unter `/run/secrets/SORTSYS_STORE_<NAME>`.
Umgebungsvariablen haben Vorrang. Vollständige Beispiele stehen in
[.compose-env.example](../.compose-env.example).

## Skalierung und Zusammenarbeit

Versionierte Metadaten, Berechtigungsprüfung und zusammengehörige Schreibzugriffe
werden im Datendienst gemeinsam bestätigt. Ein Prozesszähler oder ein lokales
Mutex ersetzt diese Grenze nicht. Die API hält keine entschlüsselten
Geschäftstabellen vor.

Ein wartender Änderungsabruf je aktivem Mandanten und API-Instanz verteilt
bestätigte Hinweise an deren WebSocket-Verbindungen. Ein Rechte- oder Sitzungsentzug
wird bei weiteren Zugriffen erneut geprüft. Der Load Balancer muss
WebSocket-Upgrades unterstützen. Die zusätzlichen Dokumentnachrichten und
laufenden Prüfpunkte werden noch auf diesen Speicherpfad umgestellt.

## Container-Image

Aus dem Hauptverzeichnis bauen:

```bash
docker build -f sortsys-api-v2/Dockerfile -t sortsys-api:local .
```

Das Produktionsimage enthält die DuckDB-Clientbibliothek und ihre festgelegten
Erweiterungen. PostgreSQL-Programme oder ein klassischer Office-Dokumentserver
werden dafür nicht benötigt. Der [Betriebsleitfaden](../docs/deployment.md)
beschreibt Compose und die getrennten Office-Origins.

## Lizenz

Für diesen Workspace gilt die [GNU Affero General Public License v3.0 only](LICENSE).

# DuckDB-Datendienst

Der Dienst speichert verschlüsselte Objektinhalte in einer Datei pro Mandant.
Mehrere API-Instanzen verwenden denselben Dienst über Quack. Sie öffnen die
Dateien nicht selbst. In beiden Compose-Dateien heißt der Dienst `duckdb` und
verwendet das API-Image mit dem Startbefehl `sortsys-duckdb`.

Die vollständige Umstellung ist noch nicht abgeschlossen: Anmeldung,
Berechtigungen, Recovery-Metadaten und alte Fachdaten liegen weiterhin in
PostgreSQL. Der [Funktionsabgleich](../../../docs/verschluesselung-funktionsabgleich.md)
beschreibt die verbleibenden Arbeiten. Die DuckDB-Datei allein genügt derzeit
nicht für eine vollständige Mandantenwiederherstellung.

## Betrieb

`SERVICE_BASE64_64_DUCKDB` in der Compose-Umgebung muss ein zufällig erzeugtes
Dienstkennwort enthalten. Es wird ausschließlich zwischen API und Datendienst
geteilt und entschlüsselt keine Mandanteninhalte. Ports 9494 und 9495 werden
nicht nach außen veröffentlicht; der Dienst liegt im internen Netz `data`.

| Variable | Verwendung |
| --- | --- |
| `DUCKDB_SERVICE_TOKEN` | Gemeinsames Dienstkennwort mit 32 bis 512 druckbaren ASCII-Zeichen |
| `DUCKDB_QUACK_URI` | Quack-Adresse für API-Verbindungen, in Compose `quack:duckdb:9494` |
| `DUCKDB_CONTROL_URL` | Interne HTTP-Verwaltung, in Compose `http://duckdb:9495` |
| `DUCKDB_QUACK_DISABLE_SSL` | In Compose `true`, da Quack nur das interne Datennetz verwendet |
| `DUCKDB_DATA_DIRECTORY` | Datenverzeichnis des Dienstes, standardmäßig `/var/lib/sortsys-duckdb` |
| `DUCKDB_EXTENSION_DIRECTORY` | Verzeichnis der festgelegten, signierten Erweiterungen |

Der Dienst legt `control.duckdb`, `tenants/<kennung>.duckdb` und abgeschlossene
Dateikopien unter `snapshots/` an. Beim Start öffnet er vorhandene
Mandantendateien wieder. Jeder Mandant besitzt eine eigene Schemaversion;
die API führt dort keine Migrationen aus.

Die Verwaltungsaufrufe `POST /tenants`, `POST /snapshots` und
`GET /snapshots/<id>` verlangen das Dienstkennwort als Bearer-Token.
`GET /health` prüft die Datenbankverbindung. Diese Routen gehören zum internen
Betrieb und stehen Benutzern nicht als API zur Verfügung. Snapshots werden
derzeit nicht automatisch gelöscht.

## Entwicklung und Prüfungen

`./scripts/dev` baut und startet den Datendienst vor der API. Für lokale
Rust-Befehle außerhalb der Container wird zusätzlich die native DuckDB-Bibliothek
benötigt. Unter Linux lässt sie sich aus `sortsys-api-v2` so bereitstellen:

```bash
bash rust-api/duckdb/install /tmp/sortsys-duckdb
export DUCKDB_LIB_DIR=/tmp/sortsys-duckdb
export DUCKDB_INCLUDE_DIR=/tmp/sortsys-duckdb
export LD_LIBRARY_PATH=/tmp/sortsys-duckdb${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}
export DUCKDB_EXTENSION_DIRECTORY=/tmp/sortsys-duckdb/extensions
```

Der Installer unterstützt Linux auf amd64 und arm64. Er prüft feste
SHA-256-Summen für DuckDB 2.0.0, httpfs und Quack; DuckDB prüft beim Laden
zusätzlich deren Signaturen. Die unveränderten Lizenztexte liegen unter
`licenses/` und werden in die Container übernommen. `licenses/sources.json`
nennt ihre Quellen.

Die Integrationsprüfung `./scripts/test-api` im Hauptverzeichnis startet einen
eigenen DuckDB-Testcontainer. Sie prüft Zugriffe unabhängiger Clients,
Mandantentrennung, gleichzeitiges Speichern desselben Pakets, Snapshots während
weiterer Schreibzugriffe und das erneute Lesen nach einem Dienstneustart.
Die Testdienste werden anschließend entfernt.

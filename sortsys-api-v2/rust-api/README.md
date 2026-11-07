# sortsys-api

Das Rust-Backend verarbeitet typisierte, gebündelte RPC-Aufrufe. Es verwaltet
Mandantendatenbanken, Benutzer und Passkeys, signiert Speicherzugriffe, führt
Migrationen aus und verteilt Hintergrundaufträge über WebSockets.

## Orientierung im Code

| Pfad | Zuständigkeit |
| --- | --- |
| `src/main.rs` | Prozessstart und HTTP-Listener |
| `src/api.rs` | Prozedurregistrierung und Metadaten des erzeugten Vertrags |
| `src/rpc.rs` | HTTP-Bündelung, SuperJSON-kompatible Werte und Fehlerantworten |
| `src/procedures/` | fachliche Validierung und Datenbankzugriffe |
| `src/auth.rs` und `src/webauthn.rs` | Sitzungen, Rechte, Passwörter und Passkeys |
| `src/managed_db.rs` | Lebenszyklus und Sicherungen von Mandantendatenbanken |
| `src/object_storage.rs` | S3-kompatibler Objektspeicher |
| `src/job_runners.rs` | internes WebSocket-Protokoll der Hintergrunddienste |
| `src/seed.rs` | nachvollziehbare Entwicklungs- und Testdaten |
| `migrations/` | geordnete PostgreSQL-Mandantenmigrationen |
| `tests/network_scenarios.rs` | vollständige RPC-Abläufe mit laufenden Diensten |

## Starten und prüfen

Aus `sortsys-api-v2` ausführen:

```bash
cargo run --package sortsys-api --bin sortsys-api
cargo test --package sortsys-api
cargo fmt --all -- --check
cargo clippy --package sortsys-api --all-targets -- -D warnings
```

Der direkte Start benötigt `PG_MASTER_DSN`, `JWT_SECRET` und `ADMIN_HASH`, produktiv
zusätzlich `JOB_RUNNER_TOKEN`. Die [Workspace-Konfiguration](../README.md#laufzeitkonfiguration)
beschreibt alle Variablen. `scripts/dev` im Hauptverzeichnis liefert sie und
startet PostgreSQL und MinIO mit.

## Migrationen und API-Typen

Migrationen sind im Programm enthalten und werden in Dateinamensreihenfolge
angewandt. Schemaänderungen als neue SQL-Dateien hinzufügen; möglicherweise
bereits angewandte Migrationen nicht umschreiben.

Der TypeScript-Vertrag entsteht aus `api::contract_registry()`:

```bash
cargo run --package sortsys-api --bin generate_contract
```

Bei geänderten Prozedurverträgen `client/src/generated/contract.ts` mit einchecken.

## Integrationstests

Unit-Tests ergänzen die Netzwerkprüfungen. Aus dem Hauptverzeichnis:

```bash
./scripts/test-api
```

Der Befehl startet temporäre PostgreSQL- und MinIO-Instanzen, API und zwei
Hintergrunddienste und prüft Protokoll, Mandantendatenbanken, Dateien und
Sicherungen über das Netzwerk.

## Lizenz

Für diese Crate gilt die [GNU Affero General Public License v3.0 only](../LICENSE).

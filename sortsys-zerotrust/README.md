# sortsys-zerotrust

`sortsys-zerotrust` stellt denselben Verschlüsselungs- und Signaturrahmen für
Browser und Rust-Server bereit. Der Browser verschlüsselt Inhalte und prüft sie
nach dem Entschlüsseln. Der Server kann öffentliche Signaturen, Versionen und
Berechtigungsnachweise prüfen, ohne dafür Geschäftsdaten zu erhalten.

Der allgemeine TypeScript-Einstieg ist `@sortsys/zerotrust`. Eine Anwendung legt
ihre Inhaltsbereiche selbst fest:

```ts
import { createZeroTrust } from "@sortsys/zerotrust";

const security = createZeroTrust({ facets: ["content", "prices"] });
// security.objects: verschlüsselte Inhalte und signierte Löschmarkierungen
// security.policies: signierte Rechte, ausdrückliche Verbote und Kontosperren
```

Schlüsselpakete, verschlüsselte Kontospeicher, passwortgestützte Anmeldung,
Recovery-Nachweise und OpenTimestamps sind ebenfalls enthalten. Der Kern setzt
weder eine Datenbank noch ein Webframework voraus. Die Rust-Crate heißt
`sortsys-zerotrust`; sie ist eine reguläre Cargo-Abhängigkeit und benötigt für
ihre Prüfungen keine laufende API.

Die [API-Anleitung](API.md) zeigt die Einbindung in ein anderes Projekt und die
Aufgaben des jeweiligen Speicheradapters. Sortsys verwendet zusätzlich den
Einstieg `@sortsys/zerotrust/sortsys`: Dort liegen die Fachregeln für etwa
Kalkulationspreise, Aufmaße und Abwesenheiten. Diese Regeln gehören nicht zum
allgemeinen Kern.

## Prüfungen

Im Paketverzeichnis:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
cargo fmt --all --check
cargo test --all-features --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
bun run test:portable
```

Ein öffentlicher Browser-Testvektor prüft auch anwendungsfremde Inhaltsbereiche
in Rust. `test:portable` packt beide Bibliotheken und installiert sie in einem
temporären Fremdprojekt. Dessen Browser-Code verwendet eigene Inhaltsbereiche;
der Rust-Teil prüft die frisch erzeugten Signaturen und OpenTimestamps-Nachweise.
Der Test veröffentlicht nichts und entfernt das Fremdprojekt anschließend.
Sind die Abhängigkeiten bereits in den Bun- und Cargo-Caches vorhanden,
läuft `node scripts/test-portable.mjs --offline` ohne Netzwerkzugriff.
Die OpenTimestamps-Beispiele behalten ihre
[ursprüngliche Lizenz](test/fixtures/opentimestamps.LICENSE).
Die Bibliothek steht unter [AGPL-3.0-only](LICENSE). Eine externe kryptografische
Prüfung steht aus.

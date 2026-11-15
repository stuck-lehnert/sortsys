# sortsys-api

Die Rust-Crate stellt die unabhängige API für den verschlüsselten Mandantenbetrieb
bereit. Der Browser verarbeitet Geschäftsinhalte; die API prüft Sitzungen,
signierte Berechtigungen und atomare Änderungen im gemeinsamen DuckDB-Dienst.

`src/standalone.rs` enthält die Laufzeitkonfiguration und registriert die
verfügbaren Endpunkte. `src/control.rs` verbindet Metadatenänderungen mit ihren
Vergleichsbedingungen. `src/zerotrust/` setzt die anwendungsspezifischen Regeln
auf dem gemeinsamen Framework um. `src/contracts/` beschreibt die lokal im
Browser ausgeführten Fachoperationen. PostgreSQL-Treiber, SQL-Prozeduren und
frühere Migrationsquellen gehören nicht zu dieser Crate.

[Konfiguration, Containerstart und Prüfungen](../README.md) stehen im
Workspace-README. Für lokale Entwicklung ist `scripts/dev` im Hauptverzeichnis
vorgesehen. `scripts/test-api` prüft den unabhängigen Aufbau in einem temporären
Container, einschließlich Browser-Kryptografie und mehrerer API-Instanzen.

Für diese Crate gilt die [GNU Affero General Public License v3.0 only](../LICENSE).

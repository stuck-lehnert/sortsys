# Native Dokumentbeispiele für Regressionstests

Diese Referenzdateien stammen aus den XML-Konstruktoren des Entwicklungsseedings
mit Seed 42. Im Hauptverzeichnis neu erzeugen:

    CARGO_TARGET_DIR=/tmp/sortsys-seed-target cargo run --manifest-path sortsys-api-v2/Cargo.toml --bin seed_dev -- --write-gaeb-fixtures sortsys-gaeb/scripts/fixtures/native-seed

Browserprüfungen validieren jede Datei mit den mitgelieferten offiziellen XSDs,
bearbeiten unterstützte Phasen und prüfen Ableitungen sowie Rechnungsabzüge.
Das Laufzeitseeding erzeugt Positionen aus seinem eigenen reproduzierbaren Seed;
es kopiert diese Referenzdateien nicht.

X31 enthält sechs mit dem Ursprung verknüpfte Positionen und 24 unterstützte
Maßansätze. Native FN91-Zeilen bleiben ohne XML-Kommentare des Editors ausführbar.
Geprüft werden exakte Summen, Ursprungs-IDs, Einheiten, Öffnungsgrenzen,
verlustfreies Speichern, Maßänderungen und die tatsächliche Canvas-Oberfläche.

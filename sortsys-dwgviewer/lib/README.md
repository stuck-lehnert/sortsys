# Der DWG-Parser von sortsys

Diese Rust-Crate liest DWG-Zeichnungen für `@sortsys/dwgviewer`: als native
Bibliothek in Tests und als WebAssembly im Browser-Worker. Sie liest den
Dateicontainer, rekonstruiert komprimierte Abschnitte, decodiert unterstützte
Objekte, löst Blockreferenzen auf und überführt Zeichnungselemente in das
JSON-Schema `sortsys-dwg-scene@1`. Nicht lesbare Datensätze werden als gruppierte
Diagnosen gemeldet und nicht durch vermutete Geometrie ersetzt.

## Quellstruktur

| Pfad | Zuständigkeit |
| --- | --- |
| `src/bits.rs` | byte- und bitausgerichtete DWG-Werte |
| `src/dwgfile/` | Versionsheader, Abschnittsverzeichnisse, Seiten und Dekomprimierung |
| `src/objects.rs` | Objektverzeichnisse, Rohdatensätze und Handle-Referenzen |
| `src/entities/` | Elementheader, Geometrie, Schraffuren und Versionslayouts |
| `src/projector.rs` | Überführung decodierter Objekte in die Browserszene |
| `src/projector/blocks.rs` | rekursive Auflösung von Blöcken und INSERTs |
| `src/scene.rs` | serialisierbare Szenentypen und Diagnosen |
| `src/wasm.rs` | WebAssembly-Schnittstelle für den Browser |

Formathinweise und die Herkunft aus Beispieldateien ermittelter Offsets stehen
in [`docs/provenance.md`](docs/provenance.md).

## Bauen und prüfen

Die im Repository verwendete Toolchain steht in der [CI-Konfiguration](../../.github/workflows/ci.yml).

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --locked --release --target wasm32-unknown-unknown
```

Im übergeordneten Paket installiert `npm run build:wasm:rust` bei Bedarf das
Ziel und kopiert das Modul nach `src/dwg/wasm/sortsys-dwg-rust.wasm`.

## WebAssembly-Schnittstelle

Der Browser kopiert DWG-Bytes in den Modulspeicher, ruft den Parser auf und liest
das UTF-8-JSON aus dem Ergebnispuffer. Exportiert werden:

- `sortsys_dwg_alloc`
- `sortsys_dwg_dealloc`
- `sortsys_dwg_parse`
- `sortsys_dwg_result_ptr`
- `sortsys_dwg_result_len`

Diese kleine Schnittstelle benötigt weder erzeugte Bindings noch eine zweite
JavaScript-Laufzeit im Worker.

## Lizenz

Für diese Crate gilt die [GNU Affero General Public License v3.0 only](../../LICENSE).
Referenzierte Spezifikationen und Beispieldateien behalten ihre eigenen Bedingungen.

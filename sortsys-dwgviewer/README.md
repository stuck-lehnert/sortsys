# Pläne direkt im Browser verstehen

Mit `@sortsys/dwgviewer` bleiben PDF- und DWG-Pläne dort, wo die Arbeit stattfindet:
in sortsys. Verschieben, zoomen, Ebenen einblenden und Maße ermitteln – mit
Fangpunkten, Kalibrierung sowie Strecken-, Linienzug- und Flächenmessung.
PDF.js rendert PDFs; DWG-Dateien werden in einem Web Worker gelesen.

## Verwendung

```tsx
import { PlanViewer } from "@sortsys/dwgviewer";
import "@sortsys/dwgviewer/styles.css";

<PlanViewer
  document={{
    type: "dwg",
    source: { kind: "url", url: signedDwgUrl },
  }}
/>
```

Für PDF-Pläne `type: "pdf"` mit derselben URL-Struktur verwenden. PDF-Messungen
benötigen eine Kalibrierung anhand einer bekannten Strecke. Bei DWG nutzt der
Viewer die Zeichnungseinheiten, soweit der Parser sie ermitteln kann.

## DWG-Parser

Der eigenständige [Rust-Parser](lib/README.md) läuft als kleines WebAssembly-Modul
im DWG-Worker. Bauen mit:

```bash
npm run build:wasm:rust
```

Das Ergebnis liegt unter `src/dwg/wasm/sortsys-dwg-rust.wasm`. Eine schmale
Speicher-/JSON-Schnittstelle vermeidet eine zusätzliche JavaScript-Laufzeit.

## Prüfungen

```bash
npm ci
npm run typecheck
npm test
npm run test:wasm:rust
```

Lokale DWG-Beispiele über ein Verzeichnis prüfen:

```bash
npm run smoke:wasm:rust:fixtures -- /path/to/dwg-files
```

## Öffentliche Schnittstelle

`src/index.ts` exportiert `PlanViewer`, Geometrie- und Ansichtshilfen, den
DWG-Parser-Einstieg, PDF-Ladefunktionen und Typen für Dokumente, Elemente,
Messungen, Kalibrierung und Parser. Das Paket exportiert Quellmodule und erwartet
React 19 sowie React DOM 19 von der einbindenden Anwendung.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
ODA-Spezifikation, Beispieldateien und PDF.js behalten ihre eigenen Bedingungen.

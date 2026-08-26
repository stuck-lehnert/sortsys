# @sortsys/dwgviewer

`@sortsys/dwgviewer` is the browser plan viewer used by sortsys. It renders PDFs through PDF.js and parses DWG files in a Web Worker. The viewer supports pan and zoom, layer visibility, snapping, calibration, and distance, polyline, and area measurements.

## Usage

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

Use `type: "pdf"` with the same URL source shape for PDF plans. PDF measurements require calibration against a known distance. DWG measurements use drawing units when the parser can recover them.

## DWG parser

The independent [Rust parser](lib/README.md) runs as a small WebAssembly module inside the DWG worker. Build it with:

```bash
npm run build:wasm:rust
```

The command writes `src/dwg/wasm/sortsys-dwg-rust.wasm`. The module uses a narrow allocation-and-JSON ABI and does not need a JavaScript language runtime.

## Checks

```bash
npm ci
npm run typecheck
npm test
npm run test:wasm:rust
```

To exercise local DWG samples, pass a fixture directory to the smoke script:

```bash
npm run smoke:wasm:rust:fixtures -- /path/to/dwg-files
```

## Public API

`src/index.ts` exports `PlanViewer`, geometry and viewport helpers, the DWG parser entry point, PDF loading, and the public document, entity, measurement, calibration, and parser types. The package exports source modules and expects React 19 and React DOM 19 from the consuming application.

## License

This package is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE). The Open Design Alliance specification, test fixtures, and PDF.js retain their own terms.

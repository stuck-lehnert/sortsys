# sortsys DWG parser

This Rust crate parses DWG files for `@sortsys/dwgviewer`. It builds as a native library for tests and as WebAssembly for the browser worker.

The parser reads the file container, reconstructs compressed sections, decodes supported object records, resolves block references, and projects drawing entities into the stable `sortsys-dwg-scene@1` JSON schema. Records it cannot decode are reported as grouped diagnostics instead of guessed geometry.

## Source layout

| Path | Responsibility |
| --- | --- |
| `src/bits.rs` | Byte-aligned and bit-aligned DWG values |
| `src/dwgfile/` | Version headers, section maps, pages, and decompression |
| `src/objects.rs` | Object maps, raw records, and handle references |
| `src/entities/` | Entity headers, geometry, hatches, and version-specific layouts |
| `src/projector.rs` | Conversion from decoded objects to the browser scene |
| `src/projector/blocks.rs` | Recursive block and INSERT expansion |
| `src/scene.rs` | Serializable scene types and diagnostics |
| `src/wasm.rs` | Browser-facing WebAssembly ABI |

Format notes and the provenance of fixture-derived offsets are recorded in [`docs/provenance.md`](docs/provenance.md).

## Build and test

The crate requires Rust 1.88 or newer.

```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --locked --release --target wasm32-unknown-unknown
```

From the parent package, `npm run build:wasm:rust` installs the target when needed and copies the compiled module to `src/dwg/wasm/sortsys-dwg-rust.wasm`.

## WebAssembly ABI

The browser copies a DWG byte array into module-owned memory, calls the parser, and reads a UTF-8 JSON result from the module result buffer. The exported functions are:

- `sortsys_dwg_alloc`
- `sortsys_dwg_dealloc`
- `sortsys_dwg_parse`
- `sortsys_dwg_result_ptr`
- `sortsys_dwg_result_len`

Keeping this boundary small avoids generated bindings and a second JavaScript runtime in the worker.

## License

This crate is licensed under the [GNU Affero General Public License v3.0 only](../../LICENSE). Referenced specifications and test fixtures retain their own terms.

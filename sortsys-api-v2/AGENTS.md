## Purpose
`sortsys-api-v2` provides the independent encrypted API and the first-party TypeScript transport. Business plaintext belongs to the browser. A previous PostgreSQL backup is an input to new-tenant setup, never a running database dependency or rolling upgrade source.

## Architecture
- `rust-api/src/main.rs` reads `standalone::Config`, connects the DuckDB service and starts Axum. It does not connect `AppState`, run PostgreSQL migrations, seed old tables or start persistent plaintext jobs.
- `rust-api/src/standalone.rs` assembles the production router. Native integration tests use this same router. Add a handler only after it uses the independent persistence boundary; do not fall back to an old procedure.
- `rust-api/src/control.rs` manages typed metadata reads, collection snapshots and atomic compare-and-swap transactions. All API replicas use the shared `sortsys-store` service; only that service opens tenant files.
- `rust-api/src/zerotrust/` validates public cryptographic proofs, permissions and immutable references. Authentication, rights and business changes must be checked in the same transaction. Do not validate decrypted business contents at the API.
- `sortsys-zerotrust` supplies the reusable Rust and TypeScript cryptographic framework. Keep application-specific concepts outside its generic core.
- `rust-api/src/rpc.rs` owns batching, SuperJSON envelopes, registration and contract generation. The browser's business facade implements many typed business operations locally; a generated type alone does not register a server handler.
- `rust-api/src/transport.rs` owns shared wire values and patch serialization. `rust-api/src/contracts/` describes the browser's typed business facade without registering plaintext server handlers. Preserve one Rust identity for shared values.
- `rust-api/src/operator.rs` registers the independent operator controls. Keep these metadata operations separate from the business contract stubs.
- There is no `AppState`, SQL procedure tree or PostgreSQL migration source. Do not reintroduce them. The browser's logical row model is maintained in `sortsys-webapp-v2/schema/business.json`; `scripts/generate-browser-schema.mjs` derives its fingerprint and generated browser copy without a database.

## Runtime configuration
`JWT_SECRET` (at least 32 bytes), a bcrypt `ADMIN_HASH`, `DUCKDB_QUACK_URI`, `DUCKDB_CONTROL_URL` and `DUCKDB_SERVICE_TOKEN` are required. `PORT` defaults to `3000`. API settings can be read from `/run/secrets/SORTSYS_API_V2_<NAME>`; datastore connection settings use `/run/secrets/SORTSYS_STORE_<NAME>`.

Passkeys additionally require a fixed `SORTSYS_PUBLIC_ORIGIN`. HTTPS is required except for local loopback development. Never derive the allowed origin or RP ID from request headers. Without this setting, password login remains available and passkey ceremonies are disabled.

The process listens on `0.0.0.0:{PORT}`. Terminate TLS upstream. Never add a provider-controlled password reset or tenant decryption key.

## Verification
- Rust: `cargo fmt --all --check`, `cargo test --workspace --lib`, `cargo clippy --workspace --all-targets -- -D warnings`.
- Contract, from this directory: `cargo run --bin generate_contract -- --check`.
- Client: `cd client && bunx tsc -p tsconfig.json --noEmit && bun test src/rpc.test.ts && bun run build`.
- Containerized suite: `scripts/test-api` from the monorepo root builds an isolated Rust/DuckDB/Bun/Node test image, copies a source snapshot without secrets, runs crate/client/native checks and removes its container. Logs remain at the reported path. It never starts PostgreSQL or upgrades an archived deployment.
- Native integration: `scripts/test-native-auth` from the monorepo root gives each selected test a fresh DuckDB process and data directory. Independent API instances inside that test share the same store. It requires the pinned DuckDB library/extensions, Rust and Bun, but no PostgreSQL process or development stack. `SORTSYS_NATIVE_AUTH_TEST_FILTER` can select a named test under `zerotrust::opaque::store_tests::`; an empty selection is an error. The reported log directory contains per-test logs and a `results.json` summary.
- Browser-only native cases require `SORTSYS_NATIVE_BROWSER=1`. Without it, the runner reports and excludes them from the executed count; an explicit browser-only selection fails instead of reporting an unexecuted test as passed.
- Container: from the monorepo root, `docker build -f sortsys-api-v2/Dockerfile -t sortsys-api-v2 .`.

Keep tests meaningful: check the real browser cryptography and production handlers, concurrent replicas, denied access and atomic failure. Do not substitute a mock business service for the persistence path being tested. Run suitable checks before describing a path as working.

For browser debugging, `SORTSYS_NATIVE_BROWSER_FIXTURE` can copy a stopped development-seed test's retained data into a fresh test directory. It requires that exact test filter and `SORTSYS_NATIVE_BROWSER=1`; results explicitly use mode `browser-replay`. This mode reruns browser workflows, not seed validation. Ordinary runs always create fresh data.

## Purpose
`sortsys-api-v2` is a Rust service with a small first-party TypeScript client. The former TypeScript server and its migration sources have been removed. The API is still incomplete, so preserve protocol compatibility and document missing procedures.

## Architecture overview
- **Entry point:** `rust-api/src/main.rs` validates configuration, connects the master database, binds Axum, and handles graceful shutdown.
- **Transport:** `rust-api/src/rpc.rs` implements the established batched RPC wire format, SuperJSON envelopes, typed procedure registration, and TypeScript contract generation.
- **Data layer:** `rust-api/src/database.rs` owns master/tenant pools. SQL schema history lives only in `rust-api/migrations/` and is applied by `rust-api/src/migrations.rs`.
- **Authentication:** `rust-api/src/auth.rs` implements JWT sessions and role checks. Public identifiers use the base-32 codec in `rust-api/src/ids.rs`.
- **Client:** `client/src/rpc.ts` is the framework-independent batch transport; `client/src/generated/contract.ts` is generated from the Rust registry.

## Configuration & environment
- Required variables are `JWT_SECRET`, `PG_MASTER_DSN`, and `ADMIN_HASH`; `PORT` defaults to `3000`. Production also requires `JOB_RUNNER_TOKEN`.
- Each value can alternatively be read from `/run/secrets/SORTSYS_API_V2_<NAME>`.
- The service listens on `0.0.0.0:{PORT}`. Terminate TLS upstream.

## Verification
- **Rust:** `cargo fmt --all --check`, `cargo test --workspace`, and `cargo clippy --workspace --all-targets -- -D warnings`.
- **Contract:** `cargo run --bin generate_contract -- --check`.
- **Client:** `cd client && bunx tsc -p tsconfig.json --noEmit && bun test src/rpc.test.ts && bun run build`.
- **Combined:** run `./scripts/test-api` from the repository root.
- **Container:** `docker build -t sortsys-api-v2 ./sortsys-api-v2`.

## Folder responsibilities
- `rust-api/src/`: server, transport, authentication, database, and procedures.
- `rust-api/migrations/`: authoritative SQL migrations. Add new timestamped SQL files and register them in `migrations_generated.rs`.
- `client/`: independently built TypeScript client package.
- `scripts/`: client-side operational utilities only; no server implementation belongs here.

## Workflow reminders
- Do not restore the removed TypeScript server or introduce an external RPC framework dependency.
- Only the procedures present in `client/src/generated/contract.ts` are currently supported.
- Regenerate and commit the client contract whenever procedure types change.
- Run the combined verification before merging.

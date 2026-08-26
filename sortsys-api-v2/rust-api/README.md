# sortsys-api

`sortsys-api` is the Rust backend for sortsys. It serves the typed batched RPC API, manages tenant databases, authenticates users and passkeys, signs object-storage requests, runs migrations, and coordinates background jobs over WebSockets.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/main.rs` | process startup and HTTP listener |
| `src/api.rs` | procedure registry and generated contract metadata |
| `src/rpc.rs` | HTTP batching, SuperJSON-compatible values, and error envelopes |
| `src/procedures/` | procedure validation and database operations by domain |
| `src/auth.rs` and `src/webauthn.rs` | sessions, authorization, passwords, and passkeys |
| `src/managed_db.rs` | tenant database lifecycle and backups |
| `src/object_storage.rs` | S3-compatible object storage |
| `src/job_runners.rs` | internal worker WebSocket protocol |
| `src/seed.rs` | plausible development and test data |
| `migrations/` | ordered PostgreSQL tenant migrations |
| `tests/network_scenarios.rs` | end-to-end RPC scenarios against live services |

## Run and check

Run these commands from `sortsys-api-v2`:

```bash
cargo run --package sortsys-api --bin sortsys-api
cargo test --package sortsys-api
cargo fmt --all -- --check
cargo clippy --package sortsys-api --all-targets -- -D warnings
```

Direct startup requires `PG_MASTER_DSN`, `JWT_SECRET`, and `ADMIN_HASH`; production also requires `JOB_RUNNER_TOKEN`. See the [workspace README](../README.md#runtime-configuration) for the full table. The repository-level `scripts/dev` command supplies these values and starts PostgreSQL and MinIO for you.

## Migrations and contracts

Migrations are embedded in the binary and applied in filename order. Add schema changes as new SQL files; do not rewrite a migration that may already have run.

The TypeScript contract is generated from `api::contract_registry()`:

```bash
cargo run --package sortsys-api --bin generate_contract
```

Commit the updated `client/src/generated/contract.ts` with any procedure contract change.

## Integration tests

Unit tests do not replace the network scenarios. From the repository root, run:

```bash
./scripts/test-api
```

That command provisions disposable PostgreSQL and MinIO instances, starts the API and two workers, and exercises the protocol, tenant databases, files, and backups over the network.

## License

This crate is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).


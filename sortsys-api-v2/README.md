# sortsys API workspace

This workspace contains the Rust API server and its first-party TypeScript client. The server implements the existing batched RPC wire format directly; neither package depends on tRPC at runtime.

## Structure

- [`rust-api`](rust-api/README.md) contains the Axum service, PostgreSQL migrations, procedure implementations, job-runner WebSocket endpoint, WebAuthn support, storage integration, backups, and development seed data.
- [`client`](client/README.md) contains the generated procedure types and the browser-facing RPC client.
- [`scripts`](scripts) contains tenant and import utilities.
- [`test-files`](test-files) contains fixtures used by integration scenarios.

## Development

The supported way to run the API with its required services and seeded tenant is from the repository root:

```bash
./scripts/dev
```

To work on the Rust workspace directly, install Rust 1.88 or newer and run:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

The full integration environment uses real PostgreSQL and S3-compatible storage:

```bash
../scripts/test-api
```

## Generated client contract

Procedure names and input/output types are generated from the Rust registry:

```bash
cargo run --package sortsys-api --bin generate_contract
cargo run --package sortsys-api --bin generate_contract -- --check
```

Build the client after regenerating the contract:

```bash
cd client
bun install --frozen-lockfile
bun run build
```

## Runtime configuration

The API reads the following environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `PG_MASTER_DSN` | yes | PostgreSQL connection string for the master database |
| `JWT_SECRET` | yes | secret used to sign sessions |
| `ADMIN_HASH` | yes | bcrypt password hash for the global administrator |
| `JOB_RUNNER_TOKEN` | in production | shared secret for job-runner WebSocket connections |
| `LLM_ENCRYPTION_KEY` | for LLM setup | secret used to encrypt provider API keys in the master database |
| `LLM_MCP_URL` | no | public URL of the sortsys MCP endpoint; without it, providers use function tools |
| `ONLYOFFICE_PUBLIC_URL` | for document editing | browser-reachable Document Server origin |
| `ONLYOFFICE_INTERNAL_URL` | no | Document Server origin used by the API; defaults to the public origin |
| `ONLYOFFICE_CALLBACK_URL` | for document editing | public API callback URL reachable by Document Server |
| `ONLYOFFICE_JWT_SECRET` | for document editing | shared JWT secret; must match Document Server |
| `PORT` | no | HTTP port, default `3000` |
| `NODE_ENV` | no | set to `production` to enable production requirements |

Each value can instead be mounted at `/run/secrets/SORTSYS_API_V2_<NAME>`.

## Container image

Build the production API image from this directory:

```bash
docker build -t sortsys-api:local .
```

The image includes PostgreSQL 17 client tools because backup and restore procedures call `pg_dump` and `psql`.

## License

This workspace is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

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
| `LLM_MCP_URL` | for LLM use | publicly reachable HTTPS MCP endpoint |
| `ONLYOFFICE_PUBLIC_URL` | for document editing | browser-reachable Document Server origin |
| `ONLYOFFICE_INTERNAL_URL` | no | Document Server origin used by the API; defaults to the public origin |
| `ONLYOFFICE_CALLBACK_URL` | for document editing | public API callback URL reachable by Document Server |
| `ONLYOFFICE_JWT_SECRET` | for document editing | shared JWT secret; must match Document Server |
| `DRAWIO_PUBLIC_URL` | for diagram editing | browser-reachable diagrams.net URL; may be a same-origin path such as `/drawio` |
| `PORT` | no | HTTP port, default `3000` |
| `NODE_ENV` | no | set to `production` to enable production requirements |

LLM chat and document import use the native MCP connectors from OpenAI or
Anthropic. Set `LLM_MCP_URL` to a public HTTPS URL such as
`https://sortsys.example/api/v2/internal/llm/mcp`. Other provider accounts can
remain stored, but cannot be assigned to these use cases.

Each value can instead be mounted at `/run/secrets/SORTSYS_API_V2_<NAME>`.

## Entity activity visibility

Events retain the changed column names, not copies of field values. The UI
labels the fields in German or English. Project completion and resumption
are separate actions; neither is inferred from the project's current state.

Recording a change does not grant anyone access to it. The API checks current
roles and relationships before grouping or paginating history:

- Project history requires `view:projects` or a current project assignment.
  Losing that assignment removes access, including to old events.
- Delivery notes and reports require their own read role and access to the
  associated project. A project assignment alone does not grant report access.
- Financial events require the same roles as project cost queries:
  `view:projects`, `view:deliveryNotes` and `view:dailyProjectReports`.
- Deployments require scheduling access or concern the reader themselves.
  Inventory and product-price events require their respective read roles.
- Tool bookings and transfers are visible to their participants or users with
  `view:toolTrackings`. Private project context is omitted.
- Users can read their own profile and permission history. Other users'
  permissions require tenant admin access; password changes require admin
  access or ownership. Passkey history is visible only to its owner.
- Vacation history is visible to the employee, their current supervisors
  (including indirect supervisors), or users with vacation/scheduling read
  access. `view:users` alone does not grant this access.
- Other entities follow their respective read roles. Tenant databases keep
  tenants separate. An actor ID is attribution, not an access grant.

Deleted objects remain in history, subject to these current access checks.
The dashboard shows the latest visible event per object; entity timelines keep
every event. Development seed writes are labelled as sample data, not as actions
of a real user.

## Container image

Build the production API image from this directory:

```bash
docker build -t sortsys-api:local .
```

The image includes PostgreSQL 17 client tools because backup and restore procedures call `pg_dump` and `psql`.

## License

This workspace is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

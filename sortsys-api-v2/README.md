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
| `DRAWIO_PUBLIC_URL` | for diagram editing | browser-reachable diagrams.net URL; may be a same-origin path such as `/drawio` |
| `PORT` | no | HTTP port, default `3000` |
| `NODE_ENV` | no | set to `production` to enable production requirements |

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

## ONLYOFFICE AI

In the global admin LLM page, configure a provider account, then choose its provider and model under **ONLYOFFICE**. This selection is independent of Chat and Document import. New editor sessions automatically configure ONLYOFFICE's built-in AI plugin for chat, summarization, translation, and text analysis.

Provider API keys are stored encrypted in the master database. ONLYOFFICE sends AI requests through the sortsys API using a token tied to the user's session. The API decrypts the provider key and forwards text conversations to the selected model. This endpoint does not accept custom destination URLs or calls to sortsys procedures. Provider error details and response metadata stay on the server.

The user needs `:llm` (included in `:admin`), and LLM access must be enabled for the tenant. The gateway rechecks the session, roles, tenant settings, and monthly token quota on every request. Usage appears separately as ONLYOFFICE in the global usage overview and contributes to tenant usage and quotas.

`scripts/dev` configures this use case with the development provider when credentials are present. Restart an already running dev API after changing its Rust code, and reopen documents after changing the ONLYOFFICE model.

The integration uses ONLYOFFICE's [plugin configuration](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/plugins/) and the [built-in AI plugin](https://api.onlyoffice.com/docs/ai/guides/ai-plugin/), included in the configured Document Server image. No provider keys are installed in Document Server.

## Container image

Build the production API image from this directory:

```bash
docker build -t sortsys-api:local .
```

The image includes PostgreSQL 17 client tools because backup and restore procedures call `pg_dump` and `psql`.

## License

This workspace is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).

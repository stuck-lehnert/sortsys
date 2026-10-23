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

## Deploy upgrade guard

The `Upgrade populated deploy databases` CI job runs on `predeploy` separately
from the normal repository tests. Both jobs must succeed before automatic
promotion to `deploy` and container publication.

The guard pins the current `deploy` commit, archives its API source, and runs
that version's development seed against disposable PostgreSQL and S3 services.
It retains those services and their data while replacing the API with the
candidate. The populated fixture includes users, customers, projects, products,
reports, work hours, planning, financial entries, relations, and entity history.
No production database or production credentials are used.

Before candidate bootstrap, direct SQL captures the original tenant records and
managed-database metadata. The candidate then applies the production master
bootstrap and tenant migrations. The tests check original data preservation,
registered migrations, and idempotence after reconnecting. The running candidate
must expose the original records through the API, authenticate existing accounts,
and support updates, creation, deletion, and audit history. The full existing API
and client checks run afterward. Required upgrade phases fail if their tests are
missing; an empty test selection cannot satisfy the guard.

Additive schema changes and new rows are accepted. Existing persisted fields
must remain unchanged, excluding derived search vectors. A migration that
intentionally transforms existing data needs explicit, reviewed upgrade
expectations in `rust-api/tests/upgrade_scenarios.rs`; do not remove preservation
checks to accommodate it.

Promotion checks the pinned deploy revision again and uses an atomic Git lease.
If `deploy` changes, CI must run against that new baseline. Divergent history and
superseded `predeploy` candidates are rejected. A missing `deploy` branch fails
the guard rather than falling back to an empty database.

To run locally with Docker or Podman, fetch `deploy` and pass its exact commit:

```bash
git fetch origin deploy
./scripts/test-deploy-upgrade "$(git rev-parse origin/deploy)"
```

This workflow gates automatic promotion. Repository branch protection must also
require the upgrade check if direct pushes to `deploy` are allowed by repository
policy. Changes to GitHub branch protection are not applied by this script.

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
| `LLM_MCP_URL` | for native MCP | provider-reachable URL; optional for OpenRouter |
| `ONLYOFFICE_PUBLIC_URL` | for document editing | browser-reachable Document Server origin |
| `ONLYOFFICE_INTERNAL_URL` | no | Document Server origin used by the API; defaults to the public origin |
| `ONLYOFFICE_CALLBACK_URL` | for document editing | public API callback URL reachable by Document Server |
| `ONLYOFFICE_JWT_SECRET` | for document editing | shared JWT secret; must match Document Server |
| `DRAWIO_PUBLIC_URL` | for diagram editing | browser-reachable diagrams.net URL; may be a same-origin path such as `/drawio` |
| `AUTO_BACKUPS_ENABLED` | no | daily database backups; default `true` |
| `PORT` | no | HTTP port, default `3000` |
| `NODE_ENV` | no | set to `production` to enable production requirements |

LLM chat and document import support OpenAI and Anthropic through their native
MCP connectors, and OpenRouter through an application-side MCP bridge. The
OpenRouter bridge discovers tools from MCP, presents their schemas as function
tools to the model, and executes every invocation through authenticated MCP.
It preserves the same chat permissions, proposal confirmation, and product-only
document-import scope. OpenAI and Anthropic failures do not fall back to this
bridge.

OpenAI and Anthropic use remote native MCP connectors. Set `LLM_MCP_URL` to an
HTTPS URL reachable by the selected provider, such as
`https://sortsys.example/api/v2/internal/llm/mcp`.

The OpenRouter bridge runs in the API and defaults to authenticated HTTP MCP at
`http://127.0.0.1:<PORT>/internal/llm/mcp`. It needs no public inbound MCP
endpoint. An explicit `LLM_MCP_URL` overrides this default and must be reachable
from the API; private-network addresses are supported.

Select an OpenRouter model and endpoint that support tools; document import
additionally requires structured outputs and support for any attached images.
Unsupported parameters produce an error. Other provider accounts can remain
stored, but cannot be assigned to these use cases.

Each value can instead be mounted at `/run/secrets/SORTSYS_API_V2_<NAME>`.

## MCP document access

Chat exposes `sortsys_search_documents` and `sortsys_read_document` over MCP.
Both use the signed-in user's tenant and current project-file permissions.
Search reuses the Documents page's full-text index and returns excerpts and
preview links. Reading returns bounded Unicode text pages; pass the returned
revision with each subsequent offset to detect intervening edits. No storage
credentials, object keys, or presigned download URLs are returned.

Content access uses the existing extracted-text pipeline, currently PDF text and
scanned-PDF OCR. Other files remain searchable by name. Pending, failed,
unsupported, or stale extraction is reported without claiming the document is
empty. These tools are available to chat; document-import MCP remains limited to
product catalogue searches. Document text and excerpts are untrusted data, not
instructions to the assistant.

## Automatic database backups

The API checks for due backups every minute and on startup. Managed databases
on hosts with backups enabled run daily at 02:00 in `Europe/Berlin`. At least
one retention count must be greater than zero. Existing host storage settings
and retention rules apply.

On the spring clock change, the missing 02:00 run takes place at 03:00. On the
autumn clock change, the first occurrence of 02:00 is used. A successful run
is recorded separately from retained backup files, so retention cleanup and
restarts preserve duplicate protection. Database advisory locks coordinate
API replicas and manual backup requests.

Overdue backups are caught up after startup. Failed attempts are recorded and
retried after 15 minutes. Automatic runs have a six-hour execution limit;
failed databases do not stop subsequent databases from being processed.
Temporary dump directories are owner-only and are removed on cancellation.

Set `AUTO_BACKUPS_ENABLED=false` to disable the background schedule. Manual
backups remain available. During shutdown, the API finishes its current
backup and stops before starting another database.

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

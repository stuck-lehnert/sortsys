# sortsys

sortsys is a web-based operations system for construction and trade businesses. It covers customers, projects, personnel planning, absences, tools and inventory, products, delivery notes, daily reports, Regieberichte, project files, and cost tracking. The interface is available in German and English.

## Repository layout

| Path | Purpose | Main technology |
| --- | --- | --- |
| [`sortsys-api-v2`](sortsys-api-v2/README.md) | API workspace and generated client contract | Rust, PostgreSQL |
| [`sortsys-api-v2/rust-api`](sortsys-api-v2/rust-api/README.md) | API server, migrations, and seed data | Rust, Axum, SQLx |
| [`sortsys-api-v2/client`](sortsys-api-v2/client/README.md) | Typed browser client for the RPC protocol | TypeScript |
| [`sortsys-webapp-v2`](sortsys-webapp-v2/README.md) | Browser application | React 19, React Router 7 |
| [`sortsys-react-components`](sortsys-react-components/README.md) | Shared UI components and styles | React, CSS |
| [`sortsys-dwgviewer`](sortsys-dwgviewer/README.md) | PDF and DWG plan viewer | React, Canvas, Web Workers |
| [`sortsys-dwgviewer/lib`](sortsys-dwgviewer/lib/README.md) | DWG parser compiled to WebAssembly | Rust |
| [`sortsys-v2-job_runner`](sortsys-v2-job_runner/README.md) | Media and OCR worker | Go |

## Local development

You need Bash and either Docker or Podman. Start the complete development stack from the repository root:

```bash
./scripts/dev
```

The script starts PostgreSQL, MinIO, Euro-Office Document Server, diagrams.net,
the Rust API, two job runners, and the web application. Both runners handle media
and OCR work. The development tenant is recreated and seeded on each run.

The launcher reads LLM settings from the repository-root `.env` file.
A non-empty `OPENROUTER_API_KEY` selects
`deepseek/deepseek-v4.1-flash-1017` for chat and document import. Without an
OpenRouter key, `OPENAI_API_KEY` selects `gpt-6-luna`. Set `OPENROUTER_MODEL` or
`OPENAI_MODEL` to override the corresponding default. Exported variables override
values in `.env`. The file is parsed as data, never sourced as shell code.

| Service | Default address |
| --- | --- |
| Web application | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:32532` |
| MinIO S3 API | `http://127.0.0.1:39100` |
| Euro-Office Document Server | `http://127.0.0.1:39180` |
| diagrams.net | `http://127.0.0.1:39181` |

The seeded tenant is `test`. Its default users are `john.doe` and `frank.doe`; both use the development password `123456`, and `john.doe` is an administrator. These credentials are for local development only. Startup also installs the Sortsys company logo through the normal upload API and waits for its WebP conversion and download to succeed.

Press `Ctrl+C` to stop the stack and remove its development containers. The port and image defaults can be changed through the `DEV_*` variables declared near the top of [`scripts/dev`](scripts/dev).

## Tests

The API integration script creates isolated PostgreSQL, MinIO, API, and job-runner containers. It runs the Rust unit and network tests, database and object-storage scenarios, contract checks, and client tests.

```bash
./scripts/test-api
```

Run the same complete repository check as GitHub Actions with:

```bash
./scripts/ci
```

This also checks the Go job runner, Rust DWG parser, DWG viewer, WebAssembly build, and web application. The [CI branch flow](.github/BRANCHES.md) documents how `master`, `predeploy`, and `deploy` are used.

## Deployment

The `.compose-env` file contains every environment variable relevant to a deployment. Create it from the checked-in [`.compose-env.example`](.compose-env.example) template when running the stack yourself, then replace the placeholder values:

```bash
cp .compose-env.example .compose-env
docker compose --env-file .compose-env up -d
```

We recommend deploying [`compose.yaml`](compose.yaml) with [Coolify](https://github.com/coollabsio/coolify). Coolify generates and persists the required passwords, secrets, and public service URLs automatically. The only required value you must set yourself is `ADMIN_HASH`, which must contain a bcrypt hash for the global administrator password. Mark it as a literal value in Coolify so the dollar signs in the hash are not interpolated.

If you prefer prebuilt containers, deploy [`ghcr-compose.yaml`](ghcr-compose.yaml) in Coolify instead. It pulls the `:latest` API, job-runner, and webapp images from GitHub Container Registry. The `ADMIN_HASH` requirement and the other deployment settings still apply.

The Compose stack includes [Euro-Office Document Server](https://github.com/Euro-Office/DocumentServer)
for Office documents and [diagrams.net](https://github.com/jgraph/drawio) for diagrams.
Assign a public HTTPS domain only to `webapp`; the same domain serves the editors below
`/office/` and `/drawio/`.

The document server's `JWT_SECRET` and the API's `ONLYOFFICE_JWT_SECRET` receive the same
`SERVICE_BASE64_64_ONLYOFFICE` value. Coolify generates and persists it automatically.
For local Compose, set it in `.compose-env` to a random secret of at least 32 characters.
Keep it separate from `SERVICE_BASE64_64_JWT`, which signs API sessions. Do not rotate
the document-server secret while documents are open. Local development generates a new
secret on startup unless you export `DEV_ONLYOFFICE_JWT_SECRET` (at least 32 characters).

The `onlyoffice` service name, `ONLYOFFICE_*` variables and API routes remain unchanged
because Euro-Office uses the same DocsAPI protocol. `ONLYOFFICE_IMAGE` selects the image;
the default is the official multi-architecture image pinned by digest. See the upstream
[Docker installation guide](https://euro-office.github.io/documentation/installation/docker/)
for resource requirements and persistent paths. The bundled example app is disabled.
Private-network requests are enabled so the server can download documents and send save
callbacks to the API; do not expose the document-server port directly.

Euro-Office uses new `euro-office-*` volumes. Existing ONLYOFFICE volumes are not reused
or deleted. Before switching an existing deployment, save and close all open documents,
back up the old volumes, and remove any `ONLYOFFICE_IMAGE` override that still selects
ONLYOFFICE. Tenant documents remain in the configured S3 storage; document-server caches
and its internal database are not migrated. Retain the old image, configuration and
volumes for rollback. Switching back requires restoring their original volume mappings;
do not run `compose down --volumes` as an upgrade or rollback step.

Object storage is not part of the production Compose stack. Configure an external S3-compatible service for tenant files and backups, or leave those features disabled.

### Container security and image size

The API, job runner and webapp run as non-root users. Both Compose variants drop
all Linux capabilities, enable `no-new-privileges`, and use an init process for
these services. The job runner shares a dedicated network with the API and
retains outbound access for S3. Third-party services keep their existing
configuration. The webapp, API and editors retain their proxy and callback
connections.

Euro-Office and draw.io readiness do not gate API or webapp startup. Opening an
Office document or diagram shows the loading cube while its editor is
unavailable. The webapp retries startup and replaces the cube when the editor
signals readiness. Ready editing sessions are never reloaded by this retry loop.
Nginx resolves optional editor upstreams at request time and refreshes their DNS
records, including after a container changes IP.

Nginx has a read-only root filesystem. Its generated configuration, PID and
buffered request bodies use a `noexec,nosuid,nodev` tmpfs at `/tmp`.
`WEBAPP_TMPFS_SIZE` defaults to `256m`; size it for `CLIENT_MAX_BODY_SIZE` and
concurrent uploads. This memory counts toward container memory usage. The
namespaced `net.ipv4.ip_unprivileged_port_start=0` setting preserves port 80 for
Coolify while nginx runs without capabilities. Other deployment environments
must support this sysctl or configure an unprivileged listener and matching
proxy port.

The API and runner keep disk-backed temporary space for database dumps, restores
and OCR. Their root filesystems remain writable; replacing `/tmp` with a small
RAM-backed filesystem can break large backups or PDFs. Monitor available disk
space and configure CPU, memory, PID and log-rotation limits for the
deployment's workload. PostgreSQL and the bundled editor images retain their
upstream startup permissions and writable paths.

Build contexts exclude local environment files, common credential files,
dependencies and compiled artifacts. The repository-root webapp context also
allowlists its input packages. The webapp uses the core-only nginx Alpine slim
image; the optional XSLT, GeoIP, image-filter, njs and ACME modules are unused
by this configuration. Production images use multi-stage builds. The API retains
its existing thin LTO and debug-information stripping. It copies a single libpq
shared library from its PostgreSQL build stage and installs that library's
runtime dependencies explicitly. PostgreSQL 17 backup and restore tools remain
available.

The job runner uses an Alpine runtime with Poppler, ImageMagick, JPEG/WebP
modules, fonts and German/English Tesseract models. Its stripped Go binary is
statically linked; the Go build and development stages remain on Bookworm.
Orientation/script-detection data is omitted because recognition uses the fixed
`--psm 6` text-block mode. Image preprocessing still handles EXIF orientation.
ImageMagick permits JPEG/WebP reads and PNG reads/writes. Its policy blocks
other formats, external delegates, filters and indirect file reads. PDFs are
rendered with Poppler.

CI builds all three production images without publishing them, tests real
build-context exclusions, and exercises the runtime privilege settings,
PostgreSQL backup/restore tools and read-only nginx startup. A separately
exported test binary exercises the worker's actual preprocessing and OCR code
inside its production image, including German/English images, EXIF orientation,
embedded PDF text and scanned multi-page PDFs. The test binary is excluded from
the published image. These checks must pass alongside application and
populated-upgrade tests before automatic predeploy promotion. Image sizes are
written to the runtime-test logs. The publishing workflow requests an SBOM and
minimal build provenance for each image. Keep base images and the host patched,
and scan the resulting images for vulnerabilities before deployment.

For reproducible deployments and rollbacks with `ghcr-compose.yaml`, set
`SORTSYS_API_IMAGE`, `SORTSYS_JOBRUNNER_IMAGE` and `SORTSYS_WEBAPP_IMAGE` to the
three images from the same tested revision, preferably by digest. Their defaults
remain `:latest`. Back up persistent data before changing images; never delete
volumes as an image-upgrade step.

## Community

Participation in sortsys project spaces is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

sortsys is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). If you run a modified version as a network service, section 13 requires you to offer its corresponding source to users of that service.

Third-party libraries, specifications, fixtures, and optional parser components remain subject to their own license terms and notices.

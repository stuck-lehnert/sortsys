# sortsys

sortsys is a web-based operations system for construction and trade businesses. It covers customers, projects, personnel planning, absences, tools and inventory, products, delivery notes, daily reports, Regieberichte, project files, and cost tracking. The interface is currently written in German.

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
| [`sortsys-v2-job_runner`](sortsys-v2-job_runner/README.md) | Thumbnail and logo worker | Go |

## Local development

You need Bash and either Docker or Podman. Start the complete development stack from the repository root:

```bash
./scripts/dev
```

The script starts PostgreSQL, MinIO, the Rust API, two job runners, and the web application. It recreates and seeds the development tenant on each run.

| Service | Default address |
| --- | --- |
| Web application | `http://127.0.0.1:5173` |
| API | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:32532` |
| MinIO S3 API | `http://127.0.0.1:39100` |

The seeded tenant is `test`. Its default users are `john.doe` and `frank.doe`; both use the development password `123456`, and `john.doe` is an administrator. These credentials are for local development only.

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

We recommend deploying [`compose.yaml`](compose.yaml) with [Coolify](https://github.com/coollabsio/coolify). Coolify generates and persists the required passwords, secrets, and public service URL automatically. The only required value you must set yourself is `ADMIN_HASH`, which must contain a bcrypt hash for the global administrator password. Mark it as a literal value in Coolify so the dollar signs in the hash are not interpolated.

Object storage is not part of the production Compose stack. Configure an external S3-compatible service for tenant files and backups, or leave those features disabled.

## Community

Participation in sortsys project spaces is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

sortsys is licensed under the [GNU Affero General Public License v3.0 only](LICENSE). If you run a modified version as a network service, section 13 requires you to offer its corresponding source to users of that service.

Third-party libraries, specifications, fixtures, and optional parser components remain subject to their own license terms and notices.


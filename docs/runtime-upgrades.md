# Coordinated runtime upgrades

## Current policy

- Node 24 LTS is selected in `.node-version`. CI reads that file; the image catalog, webapp builder and Node declaration packages must use the same major. Node 25 is an EOL non-LTS line. Node 26 should be considered as a separate coordinated LTS upgrade, not mixed with Node 25 or 24 declarations.
- Rust 1.99 is shared by CI, the API builder, the test-image fallback, the image catalog and the webapp's DWG/WASM builder. Updating only some of these creates an untested compiler split.
- Nginx uses the stable release line, currently `1.30.5-alpine`, rather than independently switching to mainline 1.31.
- PostgreSQL stays on the supported 17 line. Major Docker/Compose proposals are ignored until a data migration is explicitly prepared. Minor/patch updates remain eligible. The existing PostgreSQL data mounts are unchanged.

`node scripts/check-runtime-versions.mjs` and its Node test suite run at the start of `scripts/ci`. They reject image/CI/declaration drift, tag-only PostgreSQL major changes and an unverified Nginx mainline switch. Environment overrides such as `POSTGRES_IMAGE` still require operator review; checking repository defaults cannot validate a deployed override.

## Nginx verification

`scripts/test-nginx.py` takes an explicit `--nginx-command` and optionally `--mime-types`. It checks the version against the Dockerfile, runs `nginx -t` against the rendered project template, and verifies SPA routing, missing-asset responses, cache headers, office/draw.io redirects, proxy path rewriting, forwarded TLS headers and WebSocket upgrade-header forwarding.

The harness uses only temporary files and its own loopback listeners. Nginx inherits a reserved socket so requests cannot race with an unrelated local service. All child processes and threads are stopped before the test finishes. This is not a full WebSocket relay test or a test of live ONLYOFFICE/draw.io services. It also does not establish PWA/offline correctness.

Pass the exact intended Nginx executable (and its loader arguments, if needed), not an unrelated older installation. The executable version must match the configured Dockerfile patch release. No container socket or host fallback is used by the harness.

## PostgreSQL 17 → 18 migration gate

Do not deploy PostgreSQL 18 against the existing PostgreSQL 17 data volume. A Docker tag change does not upgrade a database cluster. Do not run `compose down --volumes` as an upgrade step.

Before removing the Dependabot major-update ignore and changing the runtime check:

1. **Inventory the deployment.** Record the actual image/digest, `PGDATA`, volume/mount locations, master database and all tenant databases, roles, extensions, database sizes, locales/collations and any managed Kubernetes instances. Identify all clients and scheduled jobs that can write.
2. **Create and restore-test backups.** Back up every required database and cluster globals/roles, using tools compatible with PostgreSQL 17. A `pg_dump` of only the master database does not cover tenant databases. Globals may contain password hashes; restrict access and encrypt backups. Keep a consistent snapshot by quiescing writes across dependent databases where necessary. Also protect the matching object-storage state and configuration.
3. **Prepare a separate PostgreSQL 18 instance/volume.** Prefer a rehearsed logical dump/restore for this project; use a physical `pg_upgrade` workflow only with a separately validated procedure. Never overwrite the old volume. The official 18 image changes the default layout: mount the parent `/var/lib/postgresql` and review the versioned `PGDATA` default `/var/lib/postgresql/18/docker`. Update both Compose variants and Kubernetes generation consistently when adopting that layout.
4. **Update build/test clients together.** Both API Dockerfiles currently copy binaries from `/usr/lib/postgresql/17/bin` and copy a specifically versioned libpq file. Review the actual PostgreSQL 18 client/libpq artifacts and runtime dependencies rather than changing only their source image tags. Verify API backup/restore routes with the new tools.
5. **Restore and validate staging.** Restore globals and all required databases with errors treated as failures. Check extensions, ownership/grants, sequences, tenant routing, migrations, collation/index behavior and representative data. Run the complete service-backed API suite, managed backup/restore scenarios and application workflows against the new database.
6. **Rehearse cutover and rollback.** Stop API/job-runner writers, obtain the final consistent backup, restore/upgrade, validate, then switch the deployment. Retain the old cluster and encrypted backups through the agreed rollback window. Once writes occur on PostgreSQL 18, reverting only the image tag is not a rollback; plan how those new writes would be recovered or deliberately discarded.
7. **Only then change the policy.** Update all database runtime/test/client defaults, data mounts, Kubernetes generation, checks and documentation together. Remove the major ignore only once the migration is an accepted deployment step.

This repository update deliberately performs none of those deployment or data operations.

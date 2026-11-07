# Deployment

The repository provides [source-build Compose](../compose.yaml) and
[GHCR-image Compose](../ghcr-compose.yaml). For a local Compose deployment:

```bash
cp .compose-env.example .compose-env
# Fill in the required configuration and secrets.
docker compose --env-file .compose-env up -d
```

[.compose-env.example](../.compose-env.example) documents deployment variables;
the [API configuration](../sortsys-api-v2/README.md#runtime-configuration) describes
server settings. Tenant files and backups need external S3-compatible storage;
production Compose does not include MinIO.

## Coolify and public access

Use either Compose file with Coolify. It generates and persists the configured
`SERVICE_*` secrets. Supply `ADMIN_HASH` as a bcrypt hash for the global
administrator; mark it literal so `$` characters are preserved.

Assign a public HTTPS domain to `webapp`. It proxies the API and serves editor
routes under `/office/` and `/drawio/`. Keep document-server ports internal.
Euro-Office and diagrams.net readiness do not block the core application's startup.

## Editor secrets and upgrades

Euro-Office's `JWT_SECRET` and the API's `ONLYOFFICE_JWT_SECRET` must match. Both use
`SERVICE_BASE64_64_ONLYOFFICE`, separate from the API session secret
`SERVICE_BASE64_64_JWT`. For local Compose, set a random editor secret of at least
32 characters. Rotate it only after saving and closing active documents.

The `onlyoffice` service and `ONLYOFFICE_*` names refer to Euro-Office's compatible
DocsAPI integration. `ONLYOFFICE_IMAGE` overrides the pinned default image.
See the [upstream installation guide](https://euro-office.github.io/documentation/installation/docker/)
for editor resource requirements and persistent paths.

When switching an older ONLYOFFICE deployment to Euro-Office, save and close
active documents and back up the old configuration and volumes. Euro-Office uses
separate `euro-office-*` volumes; old editor caches and databases are not migrated.
Tenant documents remain in S3. Retain the old volume mappings for rollback.

## Runtime requirements

The webapp runs with a read-only root filesystem and uses `/tmp` for generated
Nginx configuration and buffered requests. Size `WEBAPP_TMPFS_SIZE` (default
`256m`) for `CLIENT_MAX_BODY_SIZE` and concurrent uploads. Its namespaced
`net.ipv4.ip_unprivileged_port_start=0` setting permits non-root Nginx on port 80;
other environments need that setting or an adjusted listener/proxy port.

The API and job runner need writable, disk-backed temporary space for database
backups, restores and OCR. See [API replicas and collaboration](../sortsys-api-v2/README.md#replicas-and-collaboration)
when running multiple API instances behind a load balancer.

## Releases and rollback

The [release flow](../.github/BRANCHES.md) publishes API, job runner and webapp
images. `ghcr-compose.yaml` defaults to `latest`; pin `SORTSYS_API_IMAGE`,
`SORTSYS_JOBRUNNER_IMAGE` and `SORTSYS_WEBAPP_IMAGE` to the same release, preferably
by digest, for reproducible deployments.

Back up persistent data before upgrades. Keep volumes when changing images;
`compose down --volumes` deletes data. Database major upgrades require the
[documented migration procedure](runtime-upgrades.md#postgresql-17--18-migration-gate).

# Local development

Start the stack as described in the [README](../README.md#development). The launcher
runs PostgreSQL, MinIO, the API, two job runners, the webapp, Euro-Office and
diagrams.net. The editors may finish starting after the API and webapp are ready.

## Services

| Service | Default address |
| --- | --- |
| Webapp | <http://127.0.0.1:5173> |
| API | <http://127.0.0.1:3000> |
| PostgreSQL | `127.0.0.1:32532` |
| MinIO | <http://127.0.0.1:39100> |
| Euro-Office | <http://127.0.0.1:39180> |
| diagrams.net | <http://127.0.0.1:39181> |

Port and image overrides are the `DEV_*` variables near the top of
[`scripts/dev`](../scripts/dev). Set `CONTAINER_RUNTIME=docker` or `podman` to
select the engine explicitly.

## Data and logs

Each launch recreates the development databases. Service data and dependency
caches live in the gitignored `.dev-data/` directory. Stopping the stack removes
its containers and retains these folders; it does not change the next launch's
database reset. Existing editor databases are retained.

Inspect a service with `docker logs -f sortsys-dev-api` or the corresponding
Podman command. A failed API startup retains its container and writes the log to
`.dev-data/logs/api-startup.log`. The next launch replaces that container.
Editor readiness failures are reported without stopping the core application.

## LLM configuration

The launcher reads the root `.env` file as data. A nonempty `OPENROUTER_API_KEY`
selects OpenRouter; otherwise `OPENAI_API_KEY` selects OpenAI. `OPENROUTER_MODEL`
and `OPENAI_MODEL` override model defaults. Exported values take precedence over
`.env`; current defaults are defined in [`scripts/dev`](../scripts/dev).

## Seed data

The tenant `test` contains fictional company details, users, projects and native
contractor workflows in different states, including measured X31 positions and
billing examples. `john.doe` is an administrator; `frank.doe` is another sample
user. Both use `123456` for local development.

[Document fixtures](../sortsys-api-v2/seed-assets/README.md) are committed files;
seeding uploads their fixed bytes. Position data is generated from the seed RNG.

To add missing document scenarios to an existing, running development tenant:

```bash
docker exec sortsys-dev-api cargo run --package sortsys-api --bin seed_dev -- --extend-native-documents
```

This additive operation uses seed manifests and preserves existing user edits.
It does not run the database reset performed by `scripts/dev`.

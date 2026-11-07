# sortsys

Web application for contractors and trade businesses: offers, projects, personnel,
tools, materials and documents. Available in German and English.

## Development

Requires Bash and Docker or Podman. From the repository root:

```bash
./scripts/dev
```

Open <http://127.0.0.1:5173>. Local administrator: tenant `test`, user `john.doe`,
password `123456`.

**Each start recreates and seeds the development databases.** `Ctrl+C` stops the
stack. See the [development guide](docs/development.md) for configuration and logs.

## Checks

```bash
./scripts/ci        # Complete repository checks
./scripts/test-api  # API integration and client checks
```

The [CI and release flow](.github/BRANCHES.md) describes branch tests and promotion
from `predeploy` to `deploy`.

## Packages

| Package | Purpose |
| --- | --- |
| [API](sortsys-api-v2/README.md) | Rust service, tenant databases and typed TypeScript client |
| [Webapp](sortsys-webapp-v2/README.md) | React application |
| [Components](sortsys-react-components/README.md) | Shared UI controls and styles |
| [GAEB](sortsys-gaeb/README.md) | Canvas document editors and calculations |
| [Plan viewer](sortsys-dwgviewer/README.md) | PDF/DWG viewer with a Rust/WASM parser |
| [Job runner](sortsys-v2-job_runner/README.md) | Media processing and OCR |

Processing runs in the browser wherever possible. The API handles storage,
authorization and operations requiring authoritative shared state.

## Deployment

See the [deployment guide](docs/deployment.md) for Compose, Coolify and published
container images. Configuration starts with [.compose-env.example](.compose-env.example).

## License and community

[AGPL-3.0-only](LICENSE) · [Code of Conduct](CODE_OF_CONDUCT.md).
Third-party dependencies and fixtures retain their respective licenses and notices.

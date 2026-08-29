# sortsys web application

This package contains the German-language sortsys browser interface. It is built with React 19 and React Router 7 and uses the repository’s API client, component library, and plan viewer as local packages.

## Development

For the complete application with PostgreSQL, MinIO, ONLYOFFICE Document Server, API, workers, generated client, and seed data, run this from the repository root:

```bash
./scripts/dev
```

The web application is then available at `http://127.0.0.1:5173`.

To run only the frontend, first build the API client and install the local DWG viewer dependencies:

```bash
cd sortsys-api-v2/client
bun install --frozen-lockfile
bun run build

cd ../../sortsys-dwgviewer
npm ci

cd ../sortsys-webapp-v2
npm ci
npm run dev
```

The development client expects the API at `http://127.0.0.1:3000`.

## Checks and production build

```bash
npm run typecheck
npm run build
```

The production container serves the static build through Nginx. `API_UPSTREAM` selects the internal API origin and defaults to `http://api:3000`; `CLIENT_MAX_BODY_SIZE` defaults to `64m`.

Supported project attachments open in the embedded ONLYOFFICE editor. The browser loads Document Server's API from the URL returned by the authenticated Rust API; no provider token or storage URL is kept in frontend configuration.

## Local packages

- `@sortsys/v2-client` provides typed queries, mutations, authentication, and caching.
- `@sortsys/react-components` provides the shared controls and visual language.
- `@sortsys/dwgviewer` renders PDF and DWG project plans.

## License

This package is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).


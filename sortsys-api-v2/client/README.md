# @sortsys/v2-client

Typisierter Zugriff auf die sortsys-API mit vertrauten Abfrage- und Änderungsaufrufen.
`@sortsys/v2-client` bündelt Anfragen, erhält SuperJSON-kompatible Datumswerte und
übernimmt Bearer-Authentifizierung, Entdoppelung, Caching und erneutes Laden von
Streams. Zur Laufzeit besteht keine tRPC-Abhängigkeit.

## Bauen

Vor dem Build muss der erzeugte Vertrag aktuell sein:

```bash
cd sortsys-api-v2
cargo run --package sortsys-api --bin generate_contract -- --check
cd client
bun install --frozen-lockfile
bun run build
```

JavaScript, Typdeklarationen und Paketmetadaten entstehen in `dist/`.

## Verwendung

```ts
import { createClient } from "@sortsys/v2-client";

const client = createClient("/api/v2", "webapp");

await client.login({
  tenant: "example",
  username: "john.doe",
  password: "secret",
});

const [projects, error] = await client.query("projects.list", {});

if (error) {
  throw error;
}

await client.mutate("projects.create", {
  title: "Umbau Büroetage",
});
```

Pfade, Eingaben und Ergebnisse von `query` und `mutate` kommen aus
`src/generated/contract.ts`. Cache-Strategien sind `network-first`, `network-only`,
`cache-first` und `cache-only`. Tokens werden als Bearer-Header angehängt;
`restoreSession()` stellt Browsersitzungen wieder her.

## Tests

```bash
bun test
```

`scripts/test-api` im Repository prüft zusätzlich den erzeugten Vertrag und die
Client-Suite innerhalb der API-Integrationsumgebung.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).

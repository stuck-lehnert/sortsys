# @sortsys/v2-client

`@sortsys/v2-client` is the typed TypeScript client for the sortsys Rust API. It keeps the familiar path-based query and mutation style of the former tRPC client while implementing batching, SuperJSON-compatible dates, bearer authentication, request deduplication, caching, and stream refetching without a tRPC dependency.

## Build

The generated contract must be current before building:

```bash
cd sortsys-api-v2
cargo run --package sortsys-api --bin generate_contract -- --check
cd client
bun install --frozen-lockfile
bun run build
```

The build writes JavaScript, declarations, and package metadata to `dist/`.

## Usage

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

`query` and `mutate` paths, inputs, and outputs come from `src/generated/contract.ts`. Query cache strategies are `network-first`, `network-only`, `cache-first`, and `cache-only`. Authentication tokens are attached as bearer headers; browser sessions can be restored with `restoreSession()`.

## Tests

```bash
bun test
```

The repository-level `scripts/test-api` command also checks the generated contract and runs the client suite as part of the API integration environment.

## License

This package is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).


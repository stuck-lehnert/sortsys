# Dependency reduction

Prefer platform features and small first-party modules when they cover the application's actual requirements. Evaluate source usage, generated framework code and both npm and Bun lock graphs before removing a package. A missing application import does not establish that a framework dependency is unused.

## Error boundaries

`sortsys-webapp-v2/app/components/primitives/ErrorBoundary.ts` owns the React error-boundary lifecycle. Its interface supports a fallback renderer, error reporting, explicit retry and reset keys compared with `Object.is`. It has no application UI, translations, network calls or telemetry dependencies.

`ScopedErrorBoundary.tsx` supplies the existing localized fallback and client-error reporting. Feature routes continue to use that wrapper. Keep presentation and reporting out of the generic primitive.

The primitive covers descendant rendering and lifecycle failures. React error boundaries do not catch errors from event handlers, arbitrary asynchronous callbacks or server-side rendering. Callers must handle those errors at their respective boundaries.

`npm run test:error-boundary` checks the component's lifecycle contract. The tests control state scheduling and are not DOM-renderer integration tests. They run in repository CI alongside typechecks and production builds.

## Build configuration

Vite 8 resolves TypeScript paths with `resolve.tsconfigPaths: true`. The `vite-tsconfig-paths` plugin is removed; explicit browser-build and first-party-package aliases remain in `vite.config.ts`.

`isbot` remains a direct dependency because React Router's generated server entry requires it and its tooling automatically installs it when missing, including this SPA configuration.

## API client

The published `@sortsys/v2-client` package depends on `rxjs` and `superjson`. Its unused `@types/send` dependency is removed. `@types/node` remains a development dependency for build scripts and tests; the public client declarations do not require ambient Node or Bun types.

`test:local-package-locks` checks the published client dependency list and typechecks a consumer with `types: []` and `skipLibCheck: false`. It also compares the npm and Bun metadata for the API client, DWG viewer and shared React components with their source manifests. Run it after building the client.

RxJS remains part of the public observable interface. SuperJSON preserves the RPC representation of dates, big integers and undefined values. Replacing either library requires a separate compatibility assessment.

## Rust API

`sortsys-api-v2/rust-api/src/hex_encoding.rs` provides lowercase hexadecimal encoding using the Rust standard library. It preserves leading zeroes and accepts byte slices, arrays and digest buffers through `AsRef<[u8]>`. Callers retain their existing hash, HMAC, encryption and operating-system randomness implementations.

The API no longer declares `hex` directly. SQLx still requires that crate transitively, so this change removes a direct dependency without reducing the resolved Cargo package count. The helper's unit tests cover empty input, representative bytes and every byte value against standard-library formatting. The constant AES-GCM test vector is written as bytes instead of requiring a decoder.

## DWG viewer

The viewer runs its 31 existing tests with Node 24's `node:test` and `node:assert/strict`. Native TypeScript stripping executes the core modules without a test transpiler. `vitest` is removed from the viewer manifest; its standalone npm lock shrinks from 103 to 43 entries, including the root and optional platform packages. No remaining package version changes in that lock.

The pure `viewportInteractionTransform` function lives in `src/core/cadViewport.ts`. `PlanViewer.tsx` uses it and retains the previous named export. Geometry, render-model, normalization and scene-adapter assertions remain covered. These tests do not exercise a browser renderer.

`src/assets.d.ts` defines the two asset import forms used by the viewer: WASM URLs and inline worker constructors. This removes the viewer's dependence on Vite's ambient client types. The webapp continues to bundle the viewer with Vite.

Refreshing the local-package metadata also corrects stale Node 22/25 entries and the viewer's missing TypeScript 7 declarations in the webapp Bun lock. Compared with the lock before this project-wide pass, four entries disappear and 23 appear: TypeScript 7's 20 optional platform packages, its viewer-local package entry and two viewer-local React type entries. The Bun lock therefore grows by 19 entries. These are existing declared development requirements made explicit in the lock, rather than new test-framework dependencies.

## Other components

The shared React components already declare only React and React DOM peers. Their local-package metadata is covered by the lock tests; no additional utility dependency is introduced.

The Rust DWG parser retains Serde and Serde JSON for its scene serialization and browser-worker ABI. The Go job runner uses each of its three dependencies: Gorilla WebSocket for runner transport, nativewebp for WebP decoding and encoding, and `golang.org/x/image/draw` for Catmull–Rom image scaling. Replacing these requires transport, format or image-quality tests beyond a small helper replacement.

Build and maintenance scripts continue to use the existing Node, Python, shell and language toolchains. No replacement test library is added.

## Further replacements

Use a separate module with a small typed interface, define the required behavior before implementation, and test edge cases before removing the existing dependency. Check that transitive packages actually disappear and that no replacement test dependency offsets the reduction. Update both lock graphs and the license inventory.

Rich-text parsing, HTML sanitization, cryptography, compression, complex document formats and large editors need a separate assessment. These areas have substantial compatibility or security requirements and are outside this initial replacement.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRuntimeVersions } from './check-runtime-versions.mjs';

function snapshot() {
  return {
    nodeVersion: '24\n', actualNodeMajor: '24',
    ci: '      toolchain: 1.99.0\n      node-version-file: .node-version\n',
    rustImages: { api: 'FROM rust:1.99-bookworm', wasm: 'FROM rust:1.99-alpine', fallback: 'ARG RUST_IMAGE=docker.io/library/rust:1.99-bookworm' },
    nodeImages: { catalog: 'FROM docker.io/library/node:24', builder: 'FROM node:24-alpine' },
    manifests: { client: { dependencies: { '@types/node': '^24' } }, dwg: { devDependencies: { '@types/node': '^24.19.1' } } },
    postgresImages: { catalog: 'FROM docker.io/library/postgres:17-bookworm', compose: 'image: ${POSTGRES_IMAGE:-postgres:17-alpine}' },
    webappDocker: 'FROM nginx:1.30.5-alpine',
  };
}

test('accepts coordinated runtime and supported database/stable-server defaults', () => {
  assert.deepEqual(checkRuntimeVersions(snapshot()), []);
});
test('rejects the mixed Rust minors from the original grouped proposal', () => {
  const s = snapshot(); s.rustImages.wasm = 'FROM rust:1.98-alpine';
  assert.match(checkRuntimeVersions(s).join('\n'), /wasm: Rust 1.98 differs/);
});
test('rejects an outdated test-image ARG fallback', () => {
  const s = snapshot(); s.rustImages.fallback = 'ARG RUST_IMAGE=docker.io/library/rust:1.88-bookworm';
  assert.match(checkRuntimeVersions(s).join('\n'), /fallback: Rust 1.88 differs/);
});
test('rejects mismatched Node images and missing image declarations', () => {
  const s = snapshot(); s.nodeImages.catalog = 'FROM docker.io/library/node:25'; s.nodeImages.builder = '';
  const errors = checkRuntimeVersions(s).join('\n');
  assert.match(errors, /Node 25 differs/); assert.match(errors, /missing Node image/);
});
test('rejects unsupported declaration majors including the local client consumer', () => {
  const s = snapshot(); s.manifests.client.dependencies['@types/node'] = '^25.0.1';
  assert.match(checkRuntimeVersions(s).join('\n'), /client: @types\/node must match/);
});
test('rejects a different runtime or CI bypassing the shared Node version file', () => {
  const s = snapshot(); s.actualNodeMajor = '22'; s.ci = '      toolchain: 1.99.0\n      node-version: 26\n';
  const errors = checkRuntimeVersions(s).join('\n');
  assert.match(errors, /Run checks on Node 24/); assert.match(errors, /CI must read/);
});
test('rejects PostgreSQL tag-only major upgrades', () => {
  const s = snapshot(); s.postgresImages.compose = 'image: ${POSTGRES_IMAGE:-postgres:18-alpine}';
  assert.match(checkRuntimeVersions(s).join('\n'), /documented migration/);
});
test('does not confuse DSN host ports or comments with PostgreSQL images', () => {
  const s = snapshot();
  s.postgresImages.compose += '\nPG_MASTER_DSN: postgresql://example@postgres:5432/demo\n# image: postgres:18-alpine';
  assert.deepEqual(checkRuntimeVersions(s), []);
});
test('rejects unverified Nginx mainline versions', () => {
  for (const version of ['1.31', '1.31.0']) {
    const s = snapshot(); s.webappDocker = `FROM nginx:${version}-alpine`;
    assert.match(checkRuntimeVersions(s).join('\n'), /Nginx stable release/);
  }
});

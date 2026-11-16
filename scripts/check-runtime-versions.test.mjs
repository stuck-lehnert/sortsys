import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRuntimeVersions } from "./check-runtime-versions.mjs";

function snapshot() {
  return {
    nodeVersion: "24\n",
    actualNodeMajor: "24",
    ci: "      toolchain: 1.99.0\n      node-version-file: .node-version\n",
    rustImages: {
      api: "FROM rust:1.99-bookworm",
      wasm: "FROM rust:1.99-alpine",
      fallback: "ARG RUST_IMAGE=docker.io/library/rust:1.99-bookworm",
    },
    nodeImages: {
      catalog: "FROM docker.io/library/node:24",
      builder: "FROM node:24-alpine",
    },
    manifests: {
      client: { dependencies: { "@types/node": "^24" } },
      dwg: { devDependencies: { "@types/node": "^24.19.1" } },
    },
    webappDocker: "FROM nginx:1.30.5-alpine",
  };
}

test("accepts coordinated runtime and stable-server defaults", () => {
  assert.deepEqual(checkRuntimeVersions(snapshot()), []);
});
test("rejects the mixed Rust minors from the original grouped proposal", () => {
  const current = snapshot();
  current.rustImages.wasm = "FROM rust:1.98-alpine";
  assert.match(
    checkRuntimeVersions(current).join("\n"),
    /wasm: Rust 1.98 differs/,
  );
});
test("rejects an outdated test-image ARG fallback", () => {
  const current = snapshot();
  current.rustImages.fallback =
    "ARG RUST_IMAGE=docker.io/library/rust:1.88-bookworm";
  assert.match(
    checkRuntimeVersions(current).join("\n"),
    /fallback: Rust 1.88 differs/,
  );
});
test("rejects mismatched Node images and missing image declarations", () => {
  const current = snapshot();
  current.nodeImages.catalog = "FROM docker.io/library/node:25";
  current.nodeImages.builder = "";
  const errors = checkRuntimeVersions(current).join("\n");
  assert.match(errors, /Node 25 differs/);
  assert.match(errors, /missing Node image/);
});
test("rejects unsupported declaration majors including the local client consumer", () => {
  const current = snapshot();
  current.manifests.client.dependencies["@types/node"] = "^25.0.1";
  assert.match(
    checkRuntimeVersions(current).join("\n"),
    /client: @types\/node must match/,
  );
});
test("rejects a different runtime or CI bypassing the shared Node version file", () => {
  const current = snapshot();
  current.actualNodeMajor = "22";
  current.ci = "      toolchain: 1.99.0\n      node-version: 26\n";
  const errors = checkRuntimeVersions(current).join("\n");
  assert.match(errors, /Run checks on Node 24/);
  assert.match(errors, /CI must read/);
});
test("rejects unverified Nginx mainline versions", () => {
  for (const version of ["1.31", "1.31.0"]) {
    const current = snapshot();
    current.webappDocker = `FROM nginx:${version}-alpine`;
    assert.match(
      checkRuntimeVersions(current).join("\n"),
      /Nginx stable release/,
    );
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildPlan,
  collectApi,
  inspectImage,
  sealBundle,
  verifyBundle,
} from "./ci-artifacts.mjs";

const revision = "a".repeat(40);
const platform = "linux/amd64";
const script = fileURLToPath(new URL("./ci-artifacts.mjs", import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-ci-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}

function put(directory, name, content = "compiled fixture") {
  const filename = join(directory, name);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, content);

  return filename;
}

function ociImage(directory, name, attestations = true) {
  const layout = join(directory, `${name}-layout`);
  const blob = (document) => {
    const bytes = JSON.stringify(document);
    const hash = createHash("sha256").update(bytes).digest("hex");
    put(layout, `blobs/sha256/${hash}`, bytes);

    return { digest: `sha256:${hash}`, size: Buffer.byteLength(bytes) };
  };
  const config = blob({
    os: "linux",
    architecture: "amd64",
    config: { Labels: { "org.opencontainers.image.revision": revision } },
    rootfs: { type: "layers", diff_ids: [] },
  });
  const manifest = blob({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      ...config,
      mediaType: "application/vnd.oci.image.config.v1+json",
    },
    layers: [],
  });
  const descriptors = [
    {
      ...manifest,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: { os: "linux", architecture: "amd64" },
    },
  ];

  if (attestations) {
    const layers = [
      "https://spdx.dev/Document",
      "https://slsa.dev/provenance/v0.2",
    ].map((predicateType) => ({
      ...blob({ predicateType, predicate: {} }),
      mediaType: "application/vnd.in-toto+json",
    }));
    descriptors.push({
      ...blob({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          ...blob({ os: "unknown", architecture: "unknown" }),
          mediaType: "application/vnd.oci.image.config.v1+json",
        },
        layers,
      }),
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: { os: "unknown", architecture: "unknown" },
    });
  }

  const index = {
    ...blob({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: descriptors,
    }),
    mediaType: "application/vnd.oci.image.index.v1+json",
  };
  put(layout, "oci-layout", JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  put(
    layout,
    "index.json",
    JSON.stringify({ schemaVersion: 2, manifests: [index] }),
  );
  const archive = join(directory, `${name}.oci.tar`);
  execFileSync("tar", [
    "-cf",
    archive,
    "-C",
    layout,
    "oci-layout",
    "index.json",
    "blobs",
  ]);
  rmSync(layout, { recursive: true });

  return { archive, digest: index.digest, imageId: config.digest };
}

test("Bake substitutes all three compiler stages and binds tests to the production API", () => {
  const plan = buildPlan("/compiled", "/bundles", revision, platform);
  assert.deepEqual(plan.group.default.targets, [
    "api",
    "jobrunner",
    "webapp",
    "api-tests",
    "s3",
  ]);
  assert.equal(plan.target.api.contexts.builder, "/compiled/api-builder");
  assert.equal(
    plan.target.jobrunner.contexts.build,
    "/compiled/jobrunner-builder",
  );
  assert.equal(plan.target.webapp.contexts.builder, "/compiled/webapp-builder");
  assert.equal(plan.target["api-tests"].contexts.runtime, "target:api");

  for (const name of ["api", "jobrunner", "webapp"]) {
    assert.deepEqual(plan.target[name].platforms, [platform]);
    assert.deepEqual(plan.target[name].attest, [
      "type=sbom",
      "type=provenance,mode=min",
    ]);
    assert.equal(
      plan.target[name].labels["org.opencontainers.image.revision"],
      revision,
    );
    assert.equal(plan.target[name].tags, undefined);
  }

  assert.throws(() => buildPlan("/a", "/b", "latest", platform));
  assert.throws(() => buildPlan("/a", "/b", revision, "linux/386"));
});

test("Cargo collection exports actual test paths and production binaries", async (t) => {
  const directory = fixture(t);
  const target = join(directory, "target");
  const compiled = join(directory, "compiled");
  const messages = join(directory, "cargo.jsonl");
  const artifacts = [
    "sortsys_api",
    "network_scenarios",
    "upgrade_scenarios",
  ].map((name) => {
    put(target, `release/deps/${name}-123`, name);

    return {
      reason: "compiler-artifact",
      profile: { test: true },
      target: { name },
      executable: `/sortsys-api-v2/target/release/deps/${name}-123`,
    };
  });

  for (const name of ["sortsys-api", "seed_dev", "generate_contract"]) {
    put(target, `release/${name}`, `binary ${name}`);
  }

  writeFileSync(messages, artifacts.map(JSON.stringify).join("\n"));
  await collectApi(target, messages, compiled, revision);
  assert.equal(
    readFileSync(
      join(compiled, "api-builder/app/target/release/sortsys-api"),
      "utf8",
    ),
    "binary sortsys-api",
  );
  const workspace = join(compiled, "api-tests/workspace");
  assert.equal(
    readFileSync(join(workspace, "BUILD_REVISION"), "utf8"),
    `${revision}\n`,
  );
  assert.equal(
    readFileSync(join(workspace, "test-executables.tsv"), "utf8")
      .trim()
      .split("\n").length,
    3,
  );
  artifacts[0].executable = "/unexpected/release/test";
  writeFileSync(messages, artifacts.map(JSON.stringify).join("\n"));
  await assert.rejects(collectApi(target, messages, compiled, revision));
  writeFileSync(messages, JSON.stringify(artifacts[1]));
  await assert.rejects(
    collectApi(target, messages, compiled, revision),
    /upgrade_scenarios/,
  );
});

test("receipts reject stale, foreign, changed, extra and symlinked artifacts", async (t) => {
  const directory = fixture(t);
  put(directory, "seed_dev");
  await sealBundle(directory, revision, "deploy", platform);
  await verifyBundle(directory, revision, "deploy", platform);
  await assert.rejects(
    verifyBundle(directory, "b".repeat(40), "deploy", platform),
  );
  await assert.rejects(verifyBundle(directory, revision, "tests", platform));
  await assert.rejects(
    verifyBundle(directory, revision, "deploy", "linux/arm64"),
  );
  await assert.rejects(verifyBundle(directory, revision, "unknown", platform));
  put(directory, "extra");
  await assert.rejects(verifyBundle(directory, revision, "deploy", platform));
  rmSync(join(directory, "extra"));
  put(directory, "nested/build.json", "unsealed nested file");
  await assert.rejects(verifyBundle(directory, revision, "deploy", platform));
  rmSync(join(directory, "nested"), { recursive: true });
  put(directory, "seed_dev", "changed");
  await assert.rejects(
    verifyBundle(directory, revision, "deploy", platform),
    /Changed artifact/,
  );
  rmSync(join(directory, "seed_dev"));
  symlinkSync("build.json", join(directory, "seed_dev"));
  await assert.rejects(
    verifyBundle(directory, revision, "deploy", platform),
    /symlink/,
  );
  const linked = `${directory}-link`;
  symlinkSync(directory, linked);
  t.after(() => rmSync(linked));
  await assert.rejects(
    verifyBundle(linked, revision, "deploy", platform),
    /directory/,
  );
});

test("real OCI metadata requires matching revision, platform, SBOM and provenance", async (t) => {
  const directory = fixture(t);
  const image = ociImage(directory, "webapp");
  assert.deepEqual(inspectImage(image.archive, revision, platform, true), {
    digest: image.digest,
    imageId: image.imageId,
  });
  await sealBundle(directory, revision, "runtime-webapp", platform);
  await verifyBundle(directory, revision, "runtime-webapp", platform);
  assert.throws(() =>
    inspectImage(image.archive, "b".repeat(40), platform, true),
  );
  assert.throws(() =>
    inspectImage(image.archive, revision, "linux/arm64", true),
  );
  const missing = ociImage(fixture(t), "api", false);
  assert.throws(
    () => inspectImage(missing.archive, revision, platform, true),
    /SBOM/,
  );
  const worker = fixture(t);
  ociImage(worker, "jobrunner");
  await assert.rejects(
    sealBundle(worker, revision, "runtime-jobrunner", platform),
    /contents/,
  );
});

test("plan refuses unsealed compiler outputs", (t) => {
  const result = spawnSync(process.execPath, [
    script,
    "plan",
    fixture(t),
    "/bundles",
    revision,
    platform,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(String(result.stdout), "");
});

test("transport checks integrity first and preserves digests without rebuilding", async (t) => {
  const directory = fixture(t);
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  const image = ociImage(bundle, "webapp");
  await sealBundle(bundle, revision, "runtime-webapp", platform);
  const calls = join(directory, "calls.jsonl");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args.includes('--digestfile')) {
  fs.writeFileSync(args[args.indexOf('--digestfile') + 1], process.env.IMAGE_DIGEST);
}

if (args[0] === 'image') {
  console.log(process.env.IMAGE_ID);
}
`;

  for (const name of ["skopeo", "docker"]) {
    writeFileSync(join(bin, name), fake);
    chmodSync(join(bin, name), 0o755);
  }

  const invoke = (command, requested = revision) =>
    spawnSync(
      process.execPath,
      [script, command, bundle, requested, "runtime-webapp", platform],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALLS: calls,
          IMAGE_DIGEST: image.digest,
          IMAGE_ID: image.imageId,
        },
      },
    );
  assert.notEqual(invoke("publish", "b".repeat(40)).status, 0);
  assert.throws(() => readFileSync(calls));
  const loaded = invoke("load");
  assert.equal(loaded.status, 0, loaded.stderr);
  const published = invoke("publish");
  assert.equal(published.status, 0, published.stderr);
  await verifyBundle(bundle, revision, "runtime-webapp", platform);
  const events = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 4);
  assert.match(
    events[0].at(-1),
    /^docker-daemon:localhost\/sortsys-ci-webapp:/,
  );
  assert.deepEqual(events[1].slice(0, 2), ["image", "inspect"]);

  for (const event of events.slice(2)) {
    assert.equal(event[0], "copy");
    assert.ok(event.includes("--all"));
    assert.ok(event.includes("--preserve-digests"));
    assert.match(
      event.at(-1),
      /^docker:\/\/ghcr.io\/stuck-lehnert\/sortsys-webapp:/,
    );
    assert.equal(event.includes("build"), false);
  }
});

test("the plan accepts a complete sealed build and rejects changed compiler inputs", async (t) => {
  const directory = fixture(t);

  for (const name of [
    "api-builder/app/target/release/sortsys-api",
    "api-tests/workspace/BUILD_REVISION",
    "api-tests/workspace/test-executables.tsv",
    "jobrunner-builder/out/job-runner",
    "jobrunner-tests/ocr-runtime.test",
    "webapp-builder/app/sortsys-webapp-v2/build/client/index.html",
  ]) {
    put(directory, name);
  }

  await sealBundle(directory, revision, "compiled", platform);
  const args = [script, "plan", directory, "/bundles", revision, platform];
  const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    JSON.parse(valid.stdout).target.api.contexts.builder,
    join(directory, "api-builder"),
  );
  put(directory, "jobrunner-builder/out/job-runner", "changed binary");
  const invalid = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
});

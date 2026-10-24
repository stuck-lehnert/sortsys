import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revisionPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const imageNames = ["api", "jobrunner", "webapp", "api-tests", "s3"];
const kinds = [
  "compiled",
  "deploy",
  "tests",
  "runtime-api",
  "runtime-jobrunner",
  "runtime-webapp",
];

function requireBundle(kind, platform) {
  assert.ok(kinds.includes(kind), "Unknown build artifact kind");
  assert.match(platform, /^linux\/(amd64|arm64)$/);
}

function expectedImages(kind) {
  if (kind.startsWith("runtime-")) {
    return [kind.slice(8)];
  }

  return kind === "tests" ? ["api-tests", "s3"] : [];
}

function requireFiles(files, kind) {
  const required = expectedImages(kind).map((name) => `${name}.oci.tar`);

  if (kind === "runtime-jobrunner") {
    required.push("ocr-runtime.test");
  } else if (kind === "deploy") {
    required.push("seed_dev");
  }

  if (kind === "compiled") {
    for (const name of [
      "api-builder/app/target/release/sortsys-api",
      "api-tests/workspace/BUILD_REVISION",
      "api-tests/workspace/test-executables.tsv",
      "jobrunner-builder/out/job-runner",
      "jobrunner-tests/ocr-runtime.test",
      "webapp-builder/app/sortsys-webapp-v2/build/client/index.html",
    ]) {
      assert.ok(files.includes(name), `Missing compiled build input: ${name}`);
    }
  } else {
    assert.deepEqual(files, required.sort(), "Unexpected bundle contents");
  }
}

export function requireRevision(revision) {
  assert.match(
    revision ?? "",
    revisionPattern,
    "An exact build revision is required",
  );

  return revision;
}

function contained(directory, filename) {
  assert.ok(!isAbsolute(filename), `Absolute artifact path: ${filename}`);
  const path = resolve(directory, filename);
  const offset = relative(resolve(directory), path);
  assert.ok(
    offset && !offset.startsWith("..") && !isAbsolute(offset),
    filename,
  );

  return path;
}

async function filesBelow(directory, prefix = "") {
  assert.ok(
    (await lstat(join(directory, prefix))).isDirectory(),
    "Invalid artifact directory",
  );
  const files = [];

  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Artifact symlink: ${name}`);

    if (entry.isDirectory()) {
      files.push(...(await filesBelow(directory, name)));
    } else {
      assert.ok(entry.isFile(), `Artifact is not a regular file: ${name}`);
      files.push(name);
    }
  }

  return files.sort();
}

async function hashFile(filename) {
  const digest = createHash("sha256");

  for await (const chunk of createReadStream(filename)) {
    digest.update(chunk);
  }

  return digest.digest("hex");
}

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function archiveJson(archive, digest) {
  assert.match(digest, digestPattern);
  const bytes = execFileSync(
    "tar",
    ["-xOf", archive, `blobs/sha256/${digest.slice(7)}`],
    {
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(hashBytes(bytes), digest, "OCI blob digest mismatch");

  return JSON.parse(bytes);
}

export function inspectImage(archive, revision, platform, runtime) {
  const index = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "index.json"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  assert.equal(
    index.manifests?.length,
    1,
    "Expected one exported OCI image index",
  );
  const digest = index.manifests[0].digest;
  const document = archiveJson(archive, digest);
  const imageIds = [];
  const predicates = new Set();

  function visit(document) {
    if (document.manifests) {
      for (const descriptor of document.manifests) {
        visit(archiveJson(archive, descriptor.digest));
      }

      return;
    }

    assert.ok(document.config && document.layers, "Invalid OCI image manifest");
    const config = archiveJson(archive, document.config.digest);

    if (
      config.os === platform.split("/")[0] &&
      config.architecture === platform.split("/")[1]
    ) {
      assert.equal(
        config.config?.Labels?.["org.opencontainers.image.revision"],
        revision,
      );
      imageIds.push(document.config.digest);
    }

    for (const layer of document.layers) {
      if (layer.mediaType === "application/vnd.in-toto+json") {
        predicates.add(archiveJson(archive, layer.digest).predicateType);
      }
    }
  }

  visit(document);
  assert.equal(
    imageIds.length,
    1,
    "Exactly one native runtime image is required",
  );

  if (runtime) {
    assert.ok(
      predicates.has("https://spdx.dev/Document"),
      "Missing image SBOM",
    );
    assert.ok(
      [...predicates].some((value) =>
        value?.startsWith("https://slsa.dev/provenance/"),
      ),
      "Missing image build provenance",
    );
  }

  return { digest, imageId: imageIds[0] };
}

export function buildPlan(compiled, bundles, revision, platform) {
  requireRevision(revision);
  assert.match(platform, /^linux\/(amd64|arm64)$/);
  const labels = {
    "org.opencontainers.image.source":
      "https://github.com/stuck-lehnert/sortsys",
    "org.opencontainers.image.revision": revision,
  };

  function image(name, context, dockerfile, contexts = {}) {
    const group = ["api", "jobrunner", "webapp"].includes(name)
      ? `runtime-${name}`
      : "tests";
    const target = {
      context,
      dockerfile,
      contexts,
      platforms: [platform],
      labels,
      output: [`type=oci,dest=${join(bundles, group, `${name}.oci.tar`)}`],
      "cache-from": [`type=gha,scope=ci-${name}`],
      "cache-to": [`type=gha,mode=max,scope=ci-${name}`],
    };

    if (group !== "tests") {
      target.attest = ["type=sbom", "type=provenance,mode=min"];
    }

    return target;
  }

  return {
    group: { default: { targets: imageNames } },
    target: {
      api: image("api", join(root, "sortsys-api-v2"), "Dockerfile", {
        builder: join(compiled, "api-builder"),
      }),
      jobrunner: image(
        "jobrunner",
        join(root, "sortsys-v2-job_runner"),
        "Dockerfile",
        {
          build: join(compiled, "jobrunner-builder"),
        },
      ),
      webapp: image("webapp", root, "sortsys-webapp-v2/Dockerfile", {
        builder: join(compiled, "webapp-builder"),
      }),
      "api-tests": image(
        "api-tests",
        join(root, "scripts"),
        "Dockerfile.ci-tests",
        {
          runtime: "target:api",
          "test-artifacts": join(compiled, "api-tests"),
        },
      ),
      s3: image("s3", join(root, "scripts"), "Dockerfile.s3"),
    },
  };
}

export async function collectApi(target, messages, compiled, revision) {
  requireRevision(revision);
  const workspace = join(compiled, "api-tests/workspace");
  const tests = new Map();

  for (const line of (await readFile(messages, "utf8")).trim().split("\n")) {
    const artifact = JSON.parse(line);

    if (
      artifact.reason !== "compiler-artifact" ||
      !artifact.profile?.test ||
      !artifact.executable
    ) {
      continue;
    }

    const prefix = "/sortsys-api-v2/target/";
    assert.ok(artifact.executable.startsWith(prefix), artifact.executable);
    const path = artifact.executable.slice(prefix.length);
    assert.match(path, /^release\/deps\/[a-zA-Z0-9_.-]+$/);
    assert.ok(!tests.has(path), "Duplicate Cargo test executable");
    assert.ok(
      ![...tests.values()].includes(artifact.target.name),
      "Duplicate Cargo test target",
    );
    assert.match(artifact.target.name, /^[a-zA-Z0-9_-]+$/);
    tests.set(path, artifact.target.name);
  }

  for (const required of ["network_scenarios", "upgrade_scenarios"]) {
    assert.ok(
      [...tests.values()].includes(required),
      `Missing test target: ${required}`,
    );
  }

  const listing = [];

  for (const [path, name] of [...tests].sort()) {
    const destination = contained(workspace, `target/${path}`);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(contained(target, path), destination);
    await chmod(destination, 0o755);
    listing.push(`${name}\ttarget/${path}`);
  }

  for (const name of ["sortsys-api", "seed_dev", "generate_contract"]) {
    const destination = join(workspace, "target/release", name);
    await copyFile(join(target, "release", name), destination);
    await chmod(destination, 0o755);
  }

  const production = join(compiled, "api-builder/app/target/release");
  await mkdir(production, { recursive: true });
  await copyFile(
    join(workspace, "target/release/sortsys-api"),
    join(production, "sortsys-api"),
  );
  await chmod(join(production, "sortsys-api"), 0o755);
  await writeFile(
    join(workspace, "test-executables.tsv"),
    `${listing.join("\n")}\n`,
  );
  await writeFile(join(workspace, "BUILD_REVISION"), `${revision}\n`);
}

export async function sealBundle(directory, revision, kind, platform) {
  requireRevision(revision);
  requireBundle(kind, platform);
  const images = {};
  const names = await filesBelow(directory);
  requireFiles(names, kind);

  for (const name of names) {
    if (name.endsWith(".oci.tar")) {
      const image = name.slice(0, -".oci.tar".length);
      assert.ok(imageNames.includes(image), image);
      images[image] = inspectImage(
        join(directory, name),
        revision,
        platform,
        kind.startsWith("runtime-"),
      );
    }
  }

  const files = {};

  for (const name of await filesBelow(directory)) {
    assert.notEqual(name, "build.json", "Do not overwrite a sealed build");
    files[name] = await hashFile(join(directory, name));
  }

  assert.ok(Object.keys(files).length, "Empty build artifact");
  assert.deepEqual(Object.keys(images).sort(), expectedImages(kind).sort());
  const receipt = { schema: 1, revision, kind, platform, files, images };
  await writeFile(
    join(directory, "build.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );

  return receipt;
}

export async function verifyBundle(directory, revision, kind, platform) {
  requireRevision(revision);
  requireBundle(kind, platform);
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "Invalid artifact directory",
  );
  assert.ok(
    (await lstat(join(directory, "build.json"))).isFile(),
    "Invalid build receipt",
  );
  const receipt = JSON.parse(
    await readFile(join(directory, "build.json"), "utf8"),
  );
  assert.equal(receipt.schema, 1);
  assert.equal(
    receipt.revision,
    revision,
    "Build revision does not match the consumer",
  );
  assert.equal(receipt.kind, kind, "Wrong build artifact kind");
  assert.equal(
    receipt.platform,
    platform,
    "Build platform does not match the consumer",
  );
  const actual = (await filesBelow(directory)).filter(
    (name) => name !== "build.json",
  );
  assert.deepEqual(
    actual,
    Object.keys(receipt.files).sort(),
    "Unexpected artifact files",
  );

  for (const [name, digest] of Object.entries(receipt.files)) {
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(
      await hashFile(contained(directory, name)),
      digest,
      `Changed artifact: ${name}`,
    );
  }

  requireFiles(actual, kind);
  assert.deepEqual(
    Object.keys(receipt.images).sort(),
    expectedImages(kind).sort(),
  );

  for (const [name, image] of Object.entries(receipt.images)) {
    assert.ok(imageNames.includes(name));
    assert.match(image.digest, digestPattern);
    assert.match(image.imageId, digestPattern);
    assert.ok(Object.hasOwn(receipt.files, `${name}.oci.tar`));
    const inspected = inspectImage(
      join(directory, `${name}.oci.tar`),
      revision,
      platform,
      kind.startsWith("runtime-"),
    );
    assert.deepEqual(
      inspected,
      image,
      "OCI image does not match its build receipt",
    );
  }

  if (kind === "deploy") {
    assert.deepEqual(actual, ["seed_dev"]);
  }

  return receipt;
}

async function main([command, ...args]) {
  if (command === "collect-api") {
    assert.equal(args.length, 4);
    await collectApi(...args);
  } else if (command === "plan") {
    assert.equal(args.length, 4);
    await verifyBundle(args[0], args[2], "compiled", args[3]);
    console.log(JSON.stringify(buildPlan(...args), null, 2));
  } else if (command === "seal" || command === "verify") {
    assert.equal(args.length, 4);
    const operation = command === "seal" ? sealBundle : verifyBundle;
    await operation(...args);
  } else if (command === "load" || command === "publish") {
    const [directory, revision, kind, platform] = args;
    assert.equal(args.length, 4);
    const receipt = await verifyBundle(directory, revision, kind, platform);

    for (const [name, image] of Object.entries(receipt.images)) {
      const archive = `oci-archive:${join(resolve(directory), `${name}.oci.tar`)}`;
      const tag = `localhost/sortsys-ci-${name}:${revision}`;

      if (command === "load") {
        execFileSync("skopeo", ["copy", archive, `docker-daemon:${tag}`], {
          stdio: "inherit",
        });
        const actual = execFileSync(
          "docker",
          ["image", "inspect", "--format", "{{.Id}}", tag],
          {
            encoding: "utf8",
          },
        ).trim();
        assert.equal(
          actual,
          image.imageId,
          "Loaded image differs from the built image",
        );
      } else {
        assert.ok(["api", "jobrunner", "webapp"].includes(name));
        const destination = `ghcr.io/stuck-lehnert/sortsys-${name}`;
        const scratch = await mkdtemp(join(tmpdir(), "sortsys-publish-"));
        const digestFile = join(scratch, "published-digest");

        try {
          execFileSync(
            "skopeo",
            [
              "copy",
              "--all",
              "--preserve-digests",
              "--digestfile",
              digestFile,
              archive,
              `docker://${destination}:${revision.slice(0, 10)}`,
            ],
            { stdio: "inherit" },
          );
          assert.equal(
            (await readFile(digestFile, "utf8")).trim(),
            image.digest,
          );
          execFileSync(
            "skopeo",
            [
              "copy",
              "--all",
              "--preserve-digests",
              archive,
              `docker://${destination}:latest`,
            ],
            { stdio: "inherit" },
          );
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }

    if (receipt.files["ocr-runtime.test"]) {
      await chmod(join(directory, "ocr-runtime.test"), 0o755);
    }

    if (kind === "deploy") {
      await chmod(join(directory, "seed_dev"), 0o755);
    }
  } else {
    throw new Error(
      "Expected collect-api, plan, seal, verify, load or publish",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}

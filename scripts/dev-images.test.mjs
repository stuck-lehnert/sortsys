import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const development = readFileSync(new URL("./dev", import.meta.url), "utf8");

function developmentFunction(name) {
  const definition = development.match(
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
  )?.[0];

  assert.ok(definition, `${name} is defined in scripts/dev`);

  return definition;
}

function runShell(script, environment = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH, ...environment },
  });
}

test("image pull progress reaches the terminal before the pull completes", async () => {
  const script = `
set -euo pipefail
${developmentFunction("ensure_image")}
CONTAINER_RUNTIME=record_runtime
image_exists() {
  return 1
}
record_runtime() {
  test "$1" = pull
  printf 'layer is downloading\\n'
  IFS= read -r response
  test "$response" = release
}
ensure_image example/image:fixture 1
`;
  const child = spawn("bash", ["-c", script], {
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let stdout = "";
  let stderr = "";
  let progressSeen = false;
  let delayedRelease = false;
  let inputError;

  child.stdin.on("error", (error) => {
    inputError = error;
  });
  child.stdout.on("data", (data) => {
    stdout += data.toString();

    if (!progressSeen && stdout.includes("layer is downloading")) {
      progressSeen = true;
      child.stdin.end("release\n");
    }
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  const releaseTimer = setTimeout(() => {
    delayedRelease = true;
    child.stdin.end("release\n");
  }, 2000);
  const stopTimer = setTimeout(() => {
    child.stdin.destroy();
    child.kill("SIGTERM");
  }, 4000);

  try {
    const result = await closed;

    assert.equal(result.code, 0, stdout + stderr);
    assert.equal(inputError, undefined);
    assert.equal(
      delayedRelease,
      false,
      "pull output was buffered until completion",
    );
    assert.equal(progressSeen, true);
    assert.match(stdout, /\[example\/image:fixture\] layer is downloading/);
    assert.match(stdout, /Image ready: example\/image:fixture/);
  } finally {
    clearTimeout(releaseTimer);
    clearTimeout(stopTimer);
    child.stdin.destroy();

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.allSettled([closed]);
    }
  }
});

test("cached images are announced without being pulled", () => {
  const result = runShell(`
${developmentFunction("ensure_image")}
CONTAINER_RUNTIME=record_runtime
image_exists() {
  return 0
}
record_runtime() {
  echo "Unexpected pull" >&2
  return 91
}
ensure_image example/image:cached
`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Using cached image example\/image:cached/);
  assert.doesNotMatch(result.stderr, /Unexpected pull/);
});

test("failed pulls retain retries, visible errors and a failing exit status", () => {
  const result = runShell(`
${developmentFunction("ensure_image")}
CONTAINER_RUNTIME=record_runtime
image_exists() {
  return 1
}
record_runtime() {
  printf 'fixture registry failure\\n' >&2
  return 17
}
sleep() {
  return 0
}
ensure_image example/image:failure 2
`);
  const output = result.stdout + result.stderr;

  assert.equal(result.status, 1, output);
  assert.equal(output.match(/fixture registry failure/g)?.length, 2);
  assert.match(output, /attempt 1\/2/);
  assert.match(output, /attempt 2\/2/);
  assert.doesNotMatch(output, /Image ready:/);
});

function prepareImages({
  failRust = false,
  failS3 = false,
  fallback = "",
} = {}) {
  return runShell(
    `
${developmentFunction("wait_for_startup_step")}
${developmentFunction("prepare_images")}
CONTAINER_RUNTIME=record_runtime
DEV_POSTGRES_IMAGE=postgres
DEV_ONLYOFFICE_IMAGE=office
DEV_DRAWIO_IMAGE=drawio
DEV_BUN_IMAGE=bun
DEV_RUST_IMAGE=rust
DEV_NODE_IMAGE=node
DEV_GO_IMAGE=go
DEV_S3_IMAGE=s3
ensure_image() {
  printf 'Prepared fixture image %s\\n' "$1"

  if [ "$1" = rust ] && [ "$DEV_TEST_FAIL_RUST" = true ]; then
    return 1
  fi

  return 0
}
sortsys_prepare_s3_image() {
  printf 'Prepared fixture S3 image %s\\n' "$2"

  if [ "$2" = s3 ] && [ "$DEV_TEST_FAIL_S3" = true ]; then
    return 1
  fi

  return 0
}
prepare_images
printf 'Selected S3 image: %s\\n' "$DEV_S3_IMAGE"
`,
    {
      DEV_TEST_FAIL_RUST: String(failRust),
      DEV_TEST_FAIL_S3: String(failS3),
      DEV_S3_IMAGE_FALLBACK: fallback,
    },
  );
}

test("image preparation announces the dependency it is waiting for", () => {
  const result = prepareImages();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Waiting for PostgreSQL image \(postgres\)/);
  assert.match(result.stdout, /Waiting for Rust image \(rust\)/);
  assert.match(result.stdout, /Waiting for S3 image \(s3\)/);
  assert.match(result.stdout, /All development images are ready/);
});

test("S3 image fallback selection survives the preparation wait", () => {
  const result = prepareImages({ failS3: true, fallback: "fallback-s3" });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Prepared fixture S3 image fallback-s3/);
  assert.match(result.stdout, /Selected S3 image: fallback-s3/);
});

test("a required image failure still prevents startup", () => {
  const result = prepareImages({ failRust: true });
  const output = result.stdout + result.stderr;

  assert.equal(result.status, 1, output);
  assert.match(output, /Failed to prepare Rust image: rust/);
  assert.doesNotMatch(output, /All development images are ready/);
  assert.doesNotMatch(output, /Selected S3 image:/);
});

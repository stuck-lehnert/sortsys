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

function prepareImages({ failRust = false } = {}) {
  return runShell(
    `
${developmentFunction("wait_for_startup_step")}
${developmentFunction("prepare_images")}
DEV_BUN_IMAGE=bun
DEV_RUST_IMAGE=rust
DEV_NODE_IMAGE=node
ensure_image() {
  printf 'Prepared fixture image %s\\n' "$1"
  if [ "$1" = rust ] && [ "$DEV_TEST_FAIL_RUST" = true ]; then
    return 1
  fi
}
prepare_images
printf 'All selected images ready\\n'
`,
    { DEV_TEST_FAIL_RUST: String(failRust) },
  );
}

test("image preparation waits for the independent runtime dependencies", () => {
  const result = prepareImages();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Waiting for rust/);
  assert.match(result.stdout, /All selected images ready/);
  assert.doesNotMatch(result.stdout, /postgres|s3|go|drawio/);
});

test("a required image failure prevents startup", () => {
  const result = prepareImages({ failRust: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /rust startup failed/);
  assert.doesNotMatch(result.stdout, /All selected images ready/);
});

test("a failed API startup remains inspectable after cleanup", () => {
  const result = runShell(`
${developmentFunction("wait_for_api_ready")}
${developmentFunction("cleanup_containers")}
CONTAINER_RUNTIME=fixture_runtime
DEV_API_CONTAINER=fixture-api
DEV_ALL_CONTAINERS=(fixture-api fixture-duckdb)
DEV_PRESERVE_FAILED_API=false
removed_api=$(mktemp)
rm -f "$removed_api"
fixture_runtime() {
  if [ "$1" = inspect ]; then printf 'Exit code=7; compilation failed\\n'; fi
  if [ "$1" = rm ] && [ "$3" = fixture-api ]; then touch "$removed_api"; fi
}
container_is_running() { return 1; }
if wait_for_api_ready; then exit 91; fi
[ "$DEV_PRESERVE_FAILED_API" = true ]
cleanup_containers
if [ -e "$removed_api" ]; then
  rm -f "$removed_api"
  exit 92
fi
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Exit code=7/);
  assert.match(result.stderr, /Failed API container retained/);
  const start = developmentFunction("start_api_container");
  assert.doesNotMatch(start, /--rm\s*\\/);
  assert.match(start, /logs\/api-startup\.log/);
});

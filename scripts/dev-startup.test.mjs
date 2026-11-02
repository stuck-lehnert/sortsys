import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("core startup does not wait for optional editors", () => {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-dev-startup-"));
  const startup = development.slice(
    development.indexOf("\ncleanup_containers\n"),
    development.indexOf('\necho\necho "sortsys dev stack'),
  );
  const startupHelpers = [
    developmentFunction("wait_for_startup_step"),
    developmentFunction("start_optional_editor"),
  ].join("\n\n");

  assert.ok(startup.includes("initialize_development_logo"));

  try {
    const result = runShell(
      `
${startupHelpers}
cleanup_test_jobs() {
  for pid in $(jobs -pr); do
    kill "$pid" 2>/dev/null || true
  done

  wait || true
}
trap cleanup_test_jobs EXIT
record() {
  touch "$DEV_TEST_ROOT/$1"
}
cleanup_containers() {
  return 0
}
prepare_development_directories() {
  return 0
}
ensure_network() {
  return 0
}
prepare_images() {
  return 0
}
start_postgres() {
  record postgres
}
initialize_master_database() {
  test -f "$DEV_TEST_ROOT/postgres"
  record master
}
start_s3() {
  record s3
}
start_onlyoffice() {
  for ((attempt = 0; attempt < 200; attempt++)); do
    if [ -f "$DEV_TEST_ROOT/core-ready" ]; then
      record office-ready
      return 0
    fi

    sleep 0.005
  done

  echo "Test editor is still warming up" >&2
  return 1
}
start_drawio() {
  return 1
}
build_api_development_image() {
  record api-image
}
build_job_runner_development_image() {
  record runner-image
}
ensure_local_api_client_package() {
  record client
}
start_webapp_container() {
  test -f "$DEV_TEST_ROOT/client"
  record webapp
}
start_api_container() {
  for dependency in postgres master s3 api-image; do
    test -f "$DEV_TEST_ROOT/$dependency"
  done

  record api
}
start_job_runner_containers() {
  test -f "$DEV_TEST_ROOT/api"
  test -f "$DEV_TEST_ROOT/runner-image"
  record runners
}
initialize_development_logo() {
  for dependency in api webapp runners; do
    test -f "$DEV_TEST_ROOT/$dependency"
  done

  record core-ready
}
${startup}
wait
`,
      { DEV_TEST_ROOT: directory },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /diagrams\.net.*unavailable/i);
    assert.match(result.stdout, /Euro-Office.*ready/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("editor health probes are bounded and report a stalled service", () => {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-dev-probes-"));
  const capture = join(directory, "arguments");

  try {
    const result = runShell(
      `
${developmentFunction("wait_for_editor_ready")}
CONTAINER_RUNTIME=record_runtime
record_runtime() {
  printf '%s\\n' "$*" >> "$DEV_TEST_CAPTURE"
  return 1
}
container_is_running() {
  return 0
}
sleep() {
  SECONDS=$((SECONDS + 30))
}
wait_for_editor_ready office http://127.0.0.1/healthcheck Euro-Office 20
`,
      { DEV_TEST_CAPTURE: capture },
    );
    const argumentsText = readFileSync(capture, "utf8");

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(argumentsText, /--connect-timeout 2/);
    assert.match(argumentsText, /--max-time 3/);
    assert.equal(argumentsText.match(/^exec /gm)?.length, 1);
    assert.match(result.stderr, /Euro-Office did not become ready/);
    assert.match(argumentsText, /logs --tail 50 office/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("required startup failures still stop API startup", () => {
  const result = runShell(`
${developmentFunction("wait_for_startup_step")}
failed_startup() {
  return 23
}
failed_startup &
pid="$!"
wait_for_startup_step "$pid" PostgreSQL
printf 'API must not start\\n'
`);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Waiting for PostgreSQL/);
  assert.match(result.stderr, /PostgreSQL startup failed/);
  assert.doesNotMatch(result.stdout, /API must not start/);
});

test("a ready editor completes without sleeping or fetching failure logs", () => {
  const result = runShell(`
${developmentFunction("wait_for_editor_ready")}
CONTAINER_RUNTIME=record_runtime
record_runtime() {
  test "$1" = exec
}
container_is_running() {
  return 0
}
sleep() {
  echo "Unexpected sleep" >&2
  return 93
}
wait_for_editor_ready office http://127.0.0.1/healthcheck Euro-Office 20
`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Unexpected sleep/);
});

test("a stopped editor reports bounded failure logs without a health probe", () => {
  const result = runShell(`
${developmentFunction("wait_for_editor_ready")}
CONTAINER_RUNTIME=record_runtime
record_runtime() {
  printf '%s\\n' "$*"
}
container_is_running() {
  return 1
}
wait_for_editor_ready office http://127.0.0.1/healthcheck Euro-Office 20
`);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Euro-Office container stopped/);
  assert.match(result.stdout, /logs --tail 50 office/);
  assert.match(result.stderr, /ExitCode.*OOMKilled.*State\.Error/);
  assert.doesNotMatch(result.stdout, /^exec /m);
});

test("Office initialization failure prevents editor creation and probing", () => {
  const definition = developmentFunction("start_onlyoffice");
  const variables = [...new Set(definition.match(/\bDEV_[A-Z0-9_]+\b/g))];
  const environment = {
    ...Object.fromEntries(variables.map((key) => [key, key])),
    runtime_mount_suffix: "",
    SCRIPT_DIR: "/fixture/scripts",
  };
  const result = runShell(
    `
${definition}
CONTAINER_RUNTIME=record_runtime
ensure_network() {
  return 0
}
prepare_onlyoffice_storage() {
  return 23
}
record_runtime() {
  echo "Editor creation must not run" >&2
}
wait_for_editor_ready() {
  echo "Health check must not run" >&2
}
if start_onlyoffice; then
  echo "Initialization failure must propagate" >&2
  exit 99
fi
`,
    environment,
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /must not run|failure must propagate/);
});

for (const name of ["start_onlyoffice", "start_drawio"]) {
  test(`${name} stops probing when container creation fails`, () => {
    const definition = developmentFunction(name);
    const variables = [...new Set(definition.match(/\bDEV_[A-Z0-9_]+\b/g))];
    const environment = {
      ...Object.fromEntries(variables.map((key) => [key, key])),
      SCRIPT_DIR: "/fixture/scripts",
    };
    const result = runShell(
      `
${definition}
CONTAINER_RUNTIME=record_runtime
runtime_pull_args=()
runtime_mount_suffix=""
ensure_network() {
  return 0
}
prepare_onlyoffice_storage() {
  return 0
}
record_runtime() {
  return 17
}
wait_for_editor_ready() {
  echo "Health check must not run" >&2
}
if ${name}; then
  echo "Creation failure must propagate" >&2
  exit 99
fi
`,
      environment,
    );

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /Health check must not run/);
    assert.doesNotMatch(result.stderr, /Creation failure must propagate/);
  });
}

test("monitor warns once per missing editor and keeps the core running", () => {
  const result = runShell(`
${developmentFunction("monitor_containers")}
DEV_SERVICE_CONTAINERS=(api)
DEV_OPTIONAL_EDITOR_CONTAINERS=(office drawio)
CONTAINER_RUNTIME=record_runtime
container_is_running() {
  test "$1" = api
}
record_runtime() {
  echo "Unexpected log fetch" >&2
}
ticks=0
sleep() {
  ticks=$((ticks + 1))

  if [ "$ticks" -eq 2 ]; then
    return 42
  fi
}
monitor_containers
`);

  assert.equal(result.status, 42, result.stdout + result.stderr);
  assert.equal(
    result.stderr.match(/Optional editor .* is unavailable/g)?.length,
    2,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /stopped unexpectedly/);
  assert.doesNotMatch(result.stderr, /Unexpected log fetch/);
});

test("monitor still stops on a failed required container", () => {
  const result = runShell(`
${developmentFunction("monitor_containers")}
DEV_SERVICE_CONTAINERS=(api)
DEV_OPTIONAL_EDITOR_CONTAINERS=(office drawio)
CONTAINER_RUNTIME=record_runtime
container_is_running() {
  return 1
}
record_runtime() {
  printf '%s\\n' "$*"
}
monitor_containers
`);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Container stopped unexpectedly: api/);
  assert.match(result.stdout, /logs api/);
  assert.doesNotMatch(result.stderr, /Optional editor/);
});

test("API readiness reports compilation progress until the listener is ready", () => {
  const result = runShell(`
${developmentFunction("wait_for_api_ready")}
CONTAINER_RUNTIME=record_runtime
DEV_API_CONTAINER=api
sleeps=0
record_runtime() {
  test "$1" = logs

  if [ "$sleeps" -ge 10 ]; then
    printf 'sortsys Rust API listening\\n'
  fi
}
container_is_running() {
  return 0
}
sleep() {
  sleeps=$((sleeps + 1))
}
wait_for_api_ready
`);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /record_runtime logs -f api/);
  assert.match(result.stdout, /API compilation, seeding or startup.*\(10s\)/);
});

test("TCP readiness stops immediately when its required container exits", () => {
  const result = runShell(`
${developmentFunction("wait_for_tcp_port")}
container_is_running() {
  return 1
}
sleep() {
  echo "Unexpected sleep" >&2
  return 93
}
wait_for_tcp_port 127.0.0.1 1 Webapp 240 webapp
`);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Webapp container stopped during startup/);
  assert.doesNotMatch(result.stderr, /Unexpected sleep/);
});

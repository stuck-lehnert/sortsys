import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const startup = fileURLToPath(new URL("./dev-office-start", import.meta.url));

function executable(path, source, interpreter = "/usr/bin/env bash") {
  const options = interpreter === "/bin/sh" ? "set -eu" : "set -euo pipefail";
  writeFileSync(path, `#!${interpreter}\n${options}\n${source}\n`);
  chmodSync(path, 0o755);
}

function withStartupFixture(check) {
  const root = mkdtempSync(join(tmpdir(), "sortsys office startup "));
  const image = join(root, "image");
  const bin = join(root, "bin");
  const capture = join(root, "calls");

  try {
    mkdirSync(join(image, "var/lib/postgresql"), { recursive: true });
    mkdirSync(bin);
    executable(
      join(bin, "id"),
      `
if [ "$#" -eq 1 ] && [ "$1" = -u ]; then
  echo "$DEV_TEST_UID"
elif [ "$#" -eq 2 ] && [ "$1" = -u ] && [ "$2" = postgres ]; then
  echo 102
else
  exit 64
fi
`,
    );
    executable(join(bin, "stat"), 'echo "$DEV_TEST_ROOT_OWNER"');
    executable(
      join(bin, "runuser"),
      `
if [ "$1" != -u ] || [ "$2" != postgres ] || [ "$3" != -- ]; then
  exit 64
fi

shift 3

if [ "$1" = stat ]; then
  printf 'probe:postgres\n' >> "$DEV_TEST_CAPTURE"

  if [ "$DEV_TEST_PROBE_EXIT" != 0 ]; then
    exit "$DEV_TEST_PROBE_EXIT"
  fi

  echo "$DEV_TEST_POSTGRES_OWNER"
elif [ "$1" = service ]; then
  if declare -F service >/dev/null; then
    echo 'Recursive service override leaked into runuser' >&2
    exit 89
  fi

  export DEV_TEST_ACTOR=postgres
  exec "$@"
else
  exit 64
fi
`,
    );
    executable(
      join(bin, "service"),
      `
printf '%s:%s\n' "\${DEV_TEST_ACTOR:-root}" "$*" >> "$DEV_TEST_CAPTURE"

if [ "$1" = postgresql ] && [ "$2" = start ]; then
  exit "$DEV_TEST_POSTGRES_EXIT"
fi
`,
    );
    executable(
      join(image, "entrypoint.sh"),
      `
printf 'entrypoint:%s\n' "$*" >> "$DEV_TEST_CAPTURE"
service redis-server start
service postgresql start
service redis-server stop

if [ "$(command -v service)" = service ]; then
  echo 'Service override survived PostgreSQL startup' >&2
  exit 90
fi

printf 'entrypoint:complete\n' >> "$DEV_TEST_CAPTURE"
`,
      "/bin/sh",
    );
    check({ root, image, bin, capture });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function start(fixture, settings = {}, argumentsList = []) {
  return spawnSync("sh", [startup, fixture.image, ...argumentsList], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      PATH: `${fixture.bin}:${process.env.PATH}`,
      DEV_TEST_CAPTURE: fixture.capture,
      DEV_TEST_UID: "0",
      DEV_TEST_ROOT_OWNER: "0",
      DEV_TEST_POSTGRES_OWNER: "102",
      DEV_TEST_POSTGRES_EXIT: "0",
      DEV_TEST_PROBE_EXIT: "0",
      ...settings,
    },
  });
}

function recordedCalls(fixture) {
  return existsSync(fixture.capture)
    ? readFileSync(fixture.capture, "utf8").trim().split("\n")
    : [];
}

test("caller-mapped binds start only PostgreSQL as its own account", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, {}, ["--original-argument"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /caller-mapped bind ownership/);
    assert.deepEqual(recordedCalls(fixture), [
      "probe:postgres",
      "entrypoint:--original-argument",
      "root:redis-server start",
      "postgres:postgresql start",
      "root:redis-server stop",
      "entrypoint:complete",
    ]);
  });
});

test("ordinary Linux ownership retains the original entrypoint behavior", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, { DEV_TEST_ROOT_OWNER: "102" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /caller-mapped/);
    assert.deepEqual(recordedCalls(fixture), [
      "entrypoint:",
      "root:redis-server start",
      "root:postgresql start",
      "root:redis-server stop",
      "entrypoint:complete",
    ]);
  });
});

test("real root ownership is left to the pinned image's ownership repair", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, { DEV_TEST_POSTGRES_OWNER: "0" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /caller-mapped/);
    assert.ok(recordedCalls(fixture).includes("root:postgresql start"));
    assert.ok(!recordedCalls(fixture).includes("postgres:postgresql start"));
  });
});

test("a non-root entrypoint does not probe or change service accounts", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, { DEV_TEST_UID: "102" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!recordedCalls(fixture).includes("probe:postgres"));
    assert.ok(recordedCalls(fixture).includes("root:postgresql start"));
  });
});

test("PostgreSQL startup failure remains fatal to the editor", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, { DEV_TEST_POSTGRES_EXIT: "27" });
    assert.equal(result.status, 27, result.stdout + result.stderr);
    assert.ok(recordedCalls(fixture).includes("postgres:postgresql start"));
    assert.ok(!recordedCalls(fixture).includes("entrypoint:complete"));
    assert.ok(!recordedCalls(fixture).includes("root:redis-server stop"));
  });
});

test("an inaccessible postgres view fails visibly before editor startup", () => {
  withStartupFixture((fixture) => {
    const result = start(fixture, { DEV_TEST_PROBE_EXIT: "23" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /Cannot inspect Euro-Office PostgreSQL storage/,
    );
    assert.deepEqual(recordedCalls(fixture), ["probe:postgres"]);
  });
});

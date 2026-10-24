import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const runner = fileURLToPath(
  new URL("./run-prebuilt-api-tests", import.meta.url),
);
const revision = "a".repeat(40);
const phase = "capture_deploy_fixture";

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-prebuilt-tests-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executables = join(directory, "target/release/deps");
  mkdirSync(executables, { recursive: true });
  writeFileSync(join(directory, "BUILD_REVISION"), `${revision}\n`);
  const names = ["sortsys_api", "network_scenarios", "upgrade_scenarios"];
  const manifest = names.map(
    (name) => `${name}\ttarget/release/deps/${name}-123`,
  );
  writeFileSync(
    join(directory, "test-executables.tsv"),
    `${manifest.join("\n")}\n`,
  );

  for (const name of names) {
    const filename = join(executables, `${name}-123`);
    writeFileSync(
      filename,
      `#!/usr/bin/env bash
set -eu
printf '%s:%s\\n' '${name}' "$*" >> "$EVENTS"
if [[ "$*" == *--list* ]]; then
  if [ "\${MISSING_PHASE:-}" != true ]; then
    echo '${phase}: test'
  fi
elif [ "\${FAIL_TARGET:-}" = '${name}' ]; then
  exit 42
elif [ "\${SKIP_NETWORK:-}" = true ] && [ '${name}' = network_scenarios ]; then
  echo 'skipping network scenario: missing required services'
fi
`,
    );
    chmodSync(filename, 0o755);
  }

  const events = join(directory, "events");
  const run = (...args) =>
    spawnSync("bash", [runner, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SORTSYS_API_TEST_WORKSPACE: directory,
        TEST_PREBUILT_REVISION: revision,
        EVENTS: events,
        ...overrides,
      },
    });
  const calls = () => readFileSync(events, "utf8").trim().split("\n");

  return { directory, executables, run, calls };
}

test("all runs every compiled workspace target without Cargo or a compiler", (t) => {
  const f = fixture(t);
  const result = f.run("all");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    "sortsys_api:--nocapture",
    "network_scenarios:--nocapture",
    "upgrade_scenarios:--nocapture",
  ]);
});

test("a failed binary propagates its exit and prevents later targets", (t) => {
  const f = fixture(t, { FAIL_TARGET: "network_scenarios" });
  const result = f.run("all");
  assert.equal(result.status, 42);
  assert.equal(f.calls().length, 2);
});

test("network scenarios cannot silently skip required services", (t) => {
  const f = fixture(t, { SKIP_NETWORK: "true" });
  const result = f.run("all");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required network scenarios were skipped/);
});

test("a phase proves the exact ignored test exists before execution", (t) => {
  const f = fixture(t);
  const result = f.run("phase", phase);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    `upgrade_scenarios:${phase} --ignored --exact --list`,
    `upgrade_scenarios:${phase} --ignored --exact --nocapture`,
  ]);
});

test("zero selected tests and unknown phase names fail closed", (t) => {
  const f = fixture(t, { MISSING_PHASE: "true" });
  assert.notEqual(f.run("phase", phase).status, 0);
  assert.equal(f.calls().length, 1);
  assert.notEqual(f.run("phase", "renamed_phase").status, 0);
  assert.equal(f.calls().length, 1);
});

test("stale and invalid revisions are rejected before invoking any binary", (t) => {
  for (const requestedRevision of ["b".repeat(40), "latest", ""]) {
    const f = fixture(t, { TEST_PREBUILT_REVISION: requestedRevision });
    assert.notEqual(f.run("all").status, 0);
    assert.throws(f.calls);
  }
});

for (const corruption of [
  "missing",
  "symlink",
  "duplicate",
  "traversal",
  "no-network",
]) {
  test(`the executable manifest rejects ${corruption}`, (t) => {
    const f = fixture(t);
    const manifest = join(f.directory, "test-executables.tsv");
    const binary = join(f.executables, "network_scenarios-123");

    if (corruption === "missing" || corruption === "symlink") {
      rmSync(binary);

      if (corruption === "symlink") {
        symlinkSync("sortsys_api-123", binary);
      }
    } else if (corruption === "duplicate") {
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8") +
          "network_scenarios\ttarget/release/deps/network_scenarios-123\n",
      );
    } else if (corruption === "traversal") {
      writeFileSync(manifest, "network_scenarios\t../unexpected\n");
    } else {
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8")
          .split("\n")
          .filter((line) => !line.startsWith("network_scenarios\t"))
          .join("\n"),
      );
    }

    assert.notEqual(f.run("all").status, 0);
    assert.throws(f.calls);
  });
}

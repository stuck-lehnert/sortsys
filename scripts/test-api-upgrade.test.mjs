import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runHarness(t, { upgrade = true, failUpgrade = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-api-harness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const bin = join(directory, "bin");
  const baseline = join(directory, "deploy");
  const seedDirectory = join(baseline, "sortsys-api-v2/rust-api/src/bin");
  const eventsFile = join(directory, "events.jsonl");
  mkdirSync(bin);
  mkdirSync(seedDirectory, { recursive: true });
  writeFileSync(
    join(seedDirectory, "seed_dev.rs"),
    "exact deploy source fixture",
  );

  // A fake CLI records container orchestration only; it never contacts an
  // engine or claims to run migrations. Real database phases are tested apart.
  const runtime = join(bin, "docker");
  writeFileSync(
    runtime,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const record = (event) => {
  appendFileSync(process.env.EVENTS, JSON.stringify(event) + '\\n');
};
record(args);

if (args[0] === 'cp' && args[1] === '-') {
  const archive = readFileSync(0);
  const seed = execFileSync('tar', [
    '-xOf', '-', 'sortsys-api-v2/rust-api/src/bin/seed_dev.rs',
  ], { input: archive, encoding: 'utf8' });
  record(['copied-seed', seed]);
}

if (args[0] === 'inspect') {
  console.log('true');
}

if (args[0] === 'logs') {
  console.log('API: http://127.0.0.1:9000');
  console.log('sortsys deploy upgrade fixture ready');
  console.log('sortsys Rust API listening');
}

if (process.env.FAIL_UPGRADE === 'true' && args[0] === 'exec' &&
    args.includes('exercise_upgraded_deploy_fixture')) {
  process.exit(41);
}
`,
  );
  chmodSync(runtime, 0o755);

  const candidateTarget = join(directory, "candidate-target");
  const baselineTarget = join(directory, "baseline-target");
  const result = spawnSync("bash", [join(root, "scripts/test-api")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EVENTS: eventsFile,
      FAIL_UPGRADE: String(failUpgrade),
      CONTAINER_RUNTIME: "docker",
      TEST_RUN_SUFFIX: "orchestration-fixture",
      TEST_UPGRADE_FROM_DIR: upgrade ? baseline : "",
      TEST_CARGO_TARGET_DIR: candidateTarget,
      TEST_BASELINE_CARGO_TARGET_DIR: baselineTarget,
      TEST_CARGO_REGISTRY_DIR: join(directory, "registry"),
      TEST_API_PORT: "23000",
      TEST_PG_PORT: "23001",
      TEST_S3_PORT: "23002",
    },
  });
  const events = readFileSync(eventsFile, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);

  return { result, events, candidateTarget, baselineTarget };
}

function apiCreations(events) {
  return events.filter(
    (event) =>
      event[0] === "create" &&
      event.includes("sortsys-test-api-api-orchestration-fixture"),
  );
}

test("upgrade retains the populated services and isolates deploy build artifacts", (t) => {
  const { result, events, candidateTarget, baselineTarget } = runHarness(t);
  assert.equal(result.status, 0, result.stderr);

  const creations = apiCreations(events);
  assert.equal(creations.length, 2);
  assert.match(
    creations[0].at(-1),
    /cargo run --locked --package sortsys-api --bin seed_dev/,
  );
  assert.ok(creations[0].includes(`${baselineTarget}:/sortsys-api-v2/target`));
  assert.ok(creations[1].includes(`${candidateTarget}:/sortsys-api-v2/target`));
  assert.notEqual(baselineTarget, candidateTarget);

  const candidateCommand = creations[1].at(-1);
  const capture = candidateCommand.indexOf("capture_deploy_fixture");
  const migrate = candidateCommand.indexOf("migrate_deploy_fixture");
  const start = candidateCommand.indexOf("--bin sortsys-api");
  assert.ok(capture >= 0 && migrate > capture && start > migrate);

  const copies = events.filter((event) => event[0] === "copied-seed");
  assert.equal(copies[0][1], "exact deploy source fixture");
  assert.notEqual(copies[1][1], "exact deploy source fixture");

  const firstApi = events.indexOf(creations[0]);
  const nextApi = events.indexOf(creations[1]);
  const between = events.slice(firstApi, nextApi);
  const removed = between.filter((event) => event[0] === "rm");
  assert.deepEqual(removed, [
    ["rm", "-f", "sortsys-test-api-api-orchestration-fixture"],
  ]);

  const initializations = events.filter(
    (event) =>
      event[0] === "exec" &&
      event.some((argument) => argument.startsWith("CREATE DATABASE")),
  );
  assert.equal(initializations.length, 1);

  const exercise = events.findIndex((event) =>
    event.includes("exercise_upgraded_deploy_fixture"),
  );
  const fullSuite = events.findIndex(
    (event) => event.includes("cargo") && event.includes("--workspace"),
  );
  assert.ok(exercise > nextApi && fullSuite > exercise);
});

test("an upgrade API failure prevents normal tests and successful completion", (t) => {
  const { result, events } = runHarness(t, { failUpgrade: true });
  assert.equal(result.status, 41);
  assert.doesNotMatch(
    result.stdout,
    /scripts\/test-api completed successfully/,
  );
  assert.equal(
    events.some((event) => event.includes("--workspace")),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event[0] === "create" && event.includes("JOB_RUNNER_ID=test-runner-1"),
    ),
    false,
  );
});

test("fresh-instance CI keeps its existing checks without seeding a deploy baseline", (t) => {
  const { result, events } = runHarness(t, { upgrade: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(apiCreations(events).length, 1);
  assert.ok(apiCreations(events)[0].includes("TEST_UPGRADE_MANIFEST="));
  assert.equal(
    events.some((event) => event.includes("exercise_upgraded_deploy_fixture")),
    false,
  );
  assert.ok(
    events.some(
      (event) => event.includes("cargo") && event.includes("--workspace"),
    ),
  );
  assert.ok(
    events.some(
      (event) => event.includes("clippy") && event.includes("--all-targets"),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.includes("generate_contract") && event.includes("--check"),
    ),
  );
});

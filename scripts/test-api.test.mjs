import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-native-harness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "source");
  const scripts = join(root, "scripts");
  const bin = join(directory, "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  copyFileSync(
    new URL("./test-api", import.meta.url),
    join(scripts, "test-api"),
  );
  const fixtureFiles = [
    "scripts/test-api-checks",
    "sortsys-api-v2/rust-api/src/main.rs",
    "sortsys-store/src/lib.rs",
    "sortsys-zerotrust/rust/lib.rs",
    "sortsys-webapp-v2/app/root.tsx",
    "sortsys-webapp-v2/build/client/index.html",
    "sortsys-webapp-v2/build/client/assets/application.js",
    "sortsys-gaeb/src/index.ts",
    "sortsys-react-components/src/index.ts",
    "sortsys-dwgviewer/src/index.ts",
    "sortsys-api-v2/.env",
    "sortsys-webapp-v2/.env.production",
    "sortsys-webapp-v2/node_modules/local-secret",
    "sortsys-store/target/private-build-output",
    "sortsys-webapp-v2/private.pem",
    "sortsys-webapp-v2/app/._root.tsx",
  ];
  for (const name of fixtureFiles) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture\n");
  }
  const runtime = join(bin, "docker");
  writeFileSync(
    runtime,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const record = value => appendFileSync(process.env.EVENTS, JSON.stringify(value) + '\\n');
record(args);
if (args[0] === 'cp' && args[1] === '-') {
  const archive = readFileSync(0);
  const names = execFileSync('tar', ['-tf', '-'], { input: archive, encoding: 'utf8' });
  record(['snapshot', names.trim().split('\\n')]);
}
if (args[0] === 'inspect') console.log(process.env.CONTAINER_EXIT);
if (args[0] === process.env.FAIL_COMMAND) process.exit(37);
`,
  );
  chmodSync(runtime, 0o755);
  const eventsFile = join(directory, "events.jsonl");
  const logDirectory = join(directory, "logs");
  const result = spawnSync("bash", [join(scripts, "test-api")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CONTAINER_RUNTIME: "docker",
      TEST_RUN_SUFFIX: "orchestration-fixture",
      TEST_LOG_DIR: logDirectory,
      TEST_CARGO_TARGET_DIR: join(directory, "target"),
      TEST_CARGO_REGISTRY_DIR: join(directory, "registry"),
      EVENTS: eventsFile,
      CONTAINER_EXIT: String(options.exitCode ?? 0),
      FAIL_COMMAND: options.failCommand ?? "",
      TEST_NATIVE_BROWSER: options.browser ? "1" : "0",
    },
  });
  const events = existsSync(eventsFile)
    ? readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse)
    : [];
  return { result, events, logDirectory };
}

function cleanupEvents(events) {
  return events.filter((event) => event[0] === "rm");
}

test("one isolated native test container receives sources without secrets or build output", (t) => {
  const { result, events, logDirectory } = harness(t);
  assert.equal(result.status, 0, result.stderr);
  const creations = events.filter((event) => event[0] === "create");
  assert.equal(creations.length, 1);
  assert.ok(
    creations[0].includes("sortsys-native-tests-orchestration-fixture"),
  );
  assert.ok(creations[0].includes("/workspace/scripts/test-api-checks"));
  assert.equal(creations[0].includes("-p"), false);
  assert.equal(creations[0].includes("--network"), false);
  assert.doesNotMatch(creations[0].join(" "), /postgres|PG_|S3_|job.runner/);

  const [, paths] = events.find((event) => event[0] === "snapshot");
  assert.ok(paths.includes("sortsys-api-v2/rust-api/src/main.rs"));
  assert.ok(paths.includes("sortsys-zerotrust/rust/lib.rs"));
  assert.ok(paths.includes("sortsys-store/src/lib.rs"));
  assert.equal(
    paths.some((path) =>
      /\.env|node_modules|target\/|private\.pem|\/\._/.test(path),
    ),
    false,
  );
  assert.deepEqual(cleanupEvents(events), [
    ["rm", "-f", "sortsys-native-tests-orchestration-fixture"],
  ]);
  assert.ok(
    events.some((event) => event[0] === "cp" && event[2] === logDirectory),
  );
});

test("a failing suite preserves its exit code, collects logs and removes only its own container", (t) => {
  const { result, events } = harness(t, { exitCode: 29 });
  assert.equal(result.status, 29, result.stderr);
  assert.doesNotMatch(result.stdout, /Native API checks passed/);
  assert.equal(cleanupEvents(events).length, 1);
  assert.ok(
    events.some(
      (event) => event[0] === "cp" && event[1].endsWith(":/tmp/test-logs/."),
    ),
  );
});

test("browser mode copies the built SPA separately without broadening the source snapshot", (t) => {
  const { result, events } = harness(t, { browser: true });
  assert.equal(result.status, 0, result.stderr);
  const creation = events.find((event) => event[0] === "create");
  assert.ok(creation.includes("SORTSYS_NATIVE_BROWSER=1"));
  const snapshots = events.filter((event) => event[0] === "snapshot");
  assert.equal(snapshots.length, 2);
  assert.equal(
    snapshots[0][1].some((path) => path.includes("/build/")),
    false,
  );
  assert.ok(
    snapshots[1][1].includes("sortsys-webapp-v2/build/client/index.html"),
  );
  assert.ok(
    snapshots[1][1].includes(
      "sortsys-webapp-v2/build/client/assets/application.js",
    ),
  );
  assert.equal(cleanupEvents(events).length, 1);
});

test("a Docker attach failure also collects logs and cleans up", (t) => {
  const { result, events } = harness(t, { failCommand: "start" });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(cleanupEvents(events).length, 1);
});

test("a failed build never removes an existing container", (t) => {
  const { result, events } = harness(t, { failCommand: "build" });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(cleanupEvents(events).length, 0);
  assert.equal(
    events.some((event) => event[0] === "create"),
    false,
  );
});

test("a failed creation does not claim ownership of an existing container", (t) => {
  const { result, events } = harness(t, { failCommand: "create" });
  assert.equal(result.status, 37, result.stderr);
  assert.equal(cleanupEvents(events).length, 0);
});

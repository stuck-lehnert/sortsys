import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
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
const promotion = join(root, "scripts/promote-predeploy");
const upgrade = join(root, "scripts/test-deploy-upgrade");
const phaseRunner = join(
  root,
  "sortsys-api-v2/rust-api/tests/run-upgrade-phase",
);
const realGit = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-upgrade-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function git(cwd, ...args) {
  return execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // This identity belongs only to disposable test-fixture commits.
      GIT_AUTHOR_NAME: "Upgrade fixture",
      GIT_AUTHOR_EMAIL: "upgrade-fixture@example.invalid",
      GIT_COMMITTER_NAME: "Upgrade fixture",
      GIT_COMMITTER_EMAIL: "upgrade-fixture@example.invalid",
    },
  }).trim();
}

function fixture(t) {
  const directory = temporaryDirectory(t);
  const remote = join(directory, "remote.git");
  const work = join(directory, "work");
  mkdirSync(work);
  git(directory, "init", "--bare", "--initial-branch=predeploy", remote);
  git(work, "init", "--initial-branch=predeploy");
  git(work, "remote", "add", "origin", remote);

  const commit = (message) => {
    git(work, "commit", "--allow-empty", "-m", message);

    return git(work, "rev-parse", "HEAD");
  };
  const base = commit("deployed baseline");
  const intermediate = commit("intermediate release");
  const candidate = commit("candidate");
  git(
    work,
    "push",
    "origin",
    `${base}:refs/heads/deploy`,
    "HEAD:refs/heads/predeploy",
  );

  return {
    directory,
    work,
    remote,
    base,
    intermediate,
    candidate,
    commit,
    deployed: () =>
      git(directory, `--git-dir=${remote}`, "rev-parse", "refs/heads/deploy"),
    promote: (revision = candidate, baseline = base, env = {}) =>
      spawnSync("bash", [promotion, revision, baseline], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
  };
}

test("promotes the exact tested candidate from the exact tested deploy baseline", (t) => {
  const f = fixture(t);
  const result = f.promote();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.deployed(), f.candidate);
});

test("rejects a stale deploy baseline even when promotion would still fast-forward", (t) => {
  const f = fixture(t);
  git(
    f.directory,
    `--git-dir=${f.remote}`,
    "update-ref",
    "refs/heads/deploy",
    f.intermediate,
  );
  const result = f.promote();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deploy changed after the upgrade check/);
  assert.equal(f.deployed(), f.intermediate);
});

test("rejects a candidate superseded on predeploy", (t) => {
  const f = fixture(t);
  const newer = f.commit("newer predeploy");
  git(f.work, "push", "origin", `${newer}:refs/heads/predeploy`);
  const result = f.promote();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale candidate/);
  assert.equal(f.deployed(), f.base);
});

test("never rewrites divergent deploy history", (t) => {
  const f = fixture(t);
  git(f.work, "checkout", "--detach", f.base);
  const divergent = f.commit("separate deploy history");
  git(f.work, "push", "origin", `${divergent}:refs/heads/deploy`);
  const result = f.promote(f.candidate, divergent);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain the current deploy history/);
  assert.equal(f.deployed(), divergent);
});

test("an atomic lease rejects deploy changes between validation and push", (t) => {
  const f = fixture(t);
  const bin = join(f.directory, "bin");
  mkdirSync(bin);
  executable(
    join(bin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = push ]; then
  "$REAL_GIT" --git-dir="$FIXTURE_REMOTE" update-ref refs/heads/deploy "$RACE_DEPLOY"
fi

exec "$REAL_GIT" "$@"
`,
  );
  const result = f.promote(f.candidate, f.base, {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: realGit,
    FIXTURE_REMOTE: f.remote,
    RACE_DEPLOY: f.intermediate,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /stale info/);
  assert.equal(f.deployed(), f.intermediate);
});

test("promotion fails closed without a deploy branch or valid pinned SHAs", (t) => {
  const f = fixture(t);
  const invalid = f.promote(f.candidate, "");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Usage/);
  assert.equal(f.deployed(), f.base);

  git(
    f.directory,
    `--git-dir=${f.remote}`,
    "update-ref",
    "-d",
    "refs/heads/deploy",
  );
  const missing = f.promote();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /couldn't find remote ref/);
});

test("upgrade uses archived deploy source, forwards failures and removes the archive", (t) => {
  const f = fixture(t);
  const scripts = join(f.work, "scripts");
  const api = join(f.work, "sortsys-api-v2/rust-api/src/bin");
  const inspection = join(f.directory, "inspection.json");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(api, { recursive: true });
  cpSync(upgrade, join(scripts, "test-deploy-upgrade"));
  writeFileSync(join(api, "seed_dev.rs"), "deploy seed version\n");
  git(f.work, "add", "sortsys-api-v2");
  const deployed = f.commit("fixture with deploy seed");
  writeFileSync(
    join(api, "seed_dev.rs"),
    "candidate seed must not populate deploy\n",
  );
  git(f.work, "add", "sortsys-api-v2");
  f.commit("candidate seed");

  executable(
    join(scripts, "test-api"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$TEST_UPGRADE_FROM_DIR" > "$INSPECTION"
cat "$TEST_UPGRADE_FROM_DIR/sortsys-api-v2/rust-api/src/bin/seed_dev.rs" >> "$INSPECTION"
exit 37
`,
  );
  const result = spawnSync(
    "bash",
    [join(scripts, "test-deploy-upgrade"), deployed],
    {
      cwd: f.work,
      encoding: "utf8",
      env: { ...process.env, INSPECTION: inspection },
    },
  );
  assert.equal(result.status, 37, result.stderr);
  const [archive, seed] = readFileSync(inspection, "utf8").trim().split("\n");
  assert.equal(seed, "deploy seed version");
  assert.throws(() =>
    readFileSync(join(archive, "sortsys-api-v2/rust-api/src/bin/seed_dev.rs")),
  );
});

function phaseFixture(t, listing, exitStatus = 0) {
  const directory = temporaryDirectory(t);
  const bin = join(directory, "bin");
  const calls = join(directory, "calls");
  mkdirSync(bin);
  executable(
    join(bin, "cargo"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"

if [ "\${!#}" = --list ]; then
  printf '%s\\n' "$PHASE_LISTING"
  exit 0
fi

exit "$TEST_STATUS"
`,
  );

  return {
    calls,
    run: (phase = "migrate_deploy_fixture") =>
      spawnSync("bash", [phaseRunner, phase], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALLS: calls,
          PHASE_LISTING: listing,
          TEST_STATUS: String(exitStatus),
        },
      }),
  };
}

test("a missing or renamed ignored phase cannot silently pass with zero tests", (t) => {
  const f = phaseFixture(t, "0 tests, 0 benchmarks");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required deploy-upgrade test is missing/);
  assert.equal(readFileSync(f.calls, "utf8").trim().split("\n").length, 1);
});

test("upgrade phases explicitly execute the selected test and forward failures", (t) => {
  const f = phaseFixture(t, "migrate_deploy_fixture: test", 29);
  const result = f.run();
  assert.equal(result.status, 29);
  const calls = readFileSync(f.calls, "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /--ignored --exact --list$/);
  assert.match(calls[1], /--ignored --exact --nocapture$/);
});

test("unknown upgrade phase names are rejected before cargo runs", (t) => {
  const f = phaseFixture(t, "");
  const result = f.run("renamed_phase");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown deploy-upgrade test phase/);
  assert.throws(() => readFileSync(f.calls));
});

test("the workflow requires both CI jobs and passes the checked baseline to promotion", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const promote = workflow.split("  promote:\n")[1].split("  publish:\n")[0];
  assert.match(promote, /needs: \[test, upgrade\]/);
  assert.match(promote, /needs\.upgrade\.outputs\.deploy_sha/);
  assert.match(promote, /promote-predeploy "\$GITHUB_SHA" "\$DEPLOY_BASE_SHA"/);
  assert.doesNotMatch(promote, /continue-on-error|git push/);
});

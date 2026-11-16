import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
const promotion = join(root, "scripts/promote-predeploy");
const realGit = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-promotion-test-"));
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
      GIT_AUTHOR_NAME: "Promotion fixture",
      GIT_AUTHOR_EMAIL: "promotion-fixture@example.invalid",
      GIT_COMMITTER_NAME: "Promotion fixture",
      GIT_COMMITTER_EMAIL: "promotion-fixture@example.invalid",
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
    promote: (revision = candidate, env = {}) =>
      spawnSync("bash", [promotion, revision], {
        cwd: work,
        encoding: "utf8",
        env: { ...process.env, ...env },
      }),
  };
}

test("fast-forwards deploy to the exact tested predeploy commit", (t) => {
  const f = fixture(t);
  const result = f.promote();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.deployed(), f.candidate);
});

test("allows a concurrent earlier release when the tested commit contains it", (t) => {
  const f = fixture(t);
  git(
    f.directory,
    `--git-dir=${f.remote}`,
    "update-ref",
    "refs/heads/deploy",
    f.intermediate,
  );
  const result = f.promote();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.deployed(), f.candidate);
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
  const result = f.promote(f.candidate);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain the current deploy history/);
  assert.equal(f.deployed(), divergent);
});

test("a normal push rejects divergent deploy changes between validation and push", (t) => {
  const f = fixture(t);
  git(f.work, "checkout", "--detach", f.base);
  const divergent = f.commit("concurrent divergent release");
  git(f.work, "push", "origin", `${divergent}:refs/heads/concurrent`);
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
  const result = f.promote(f.candidate, {
    PATH: `${bin}:${process.env.PATH}`,
    REAL_GIT: realGit,
    FIXTURE_REMOTE: f.remote,
    RACE_DEPLOY: divergent,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rejected|non-fast-forward/);
  assert.equal(f.deployed(), divergent);
});

test("promotion fails closed without a deploy branch or valid pinned SHAs", (t) => {
  const f = fixture(t);
  const invalid = f.promote("");
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

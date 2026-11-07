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
import test from "node:test";

const script = fileURLToPath(new URL("./reuse-ci-success", import.meta.url));
const sha = "a".repeat(40);
const repository = "stuck-lehnert/sortsys";
const success = {
  id: 123,
  path: ".github/workflows/ci.yml",
  event: "push",
  head_sha: sha,
  head_branch: "feat/already-tested",
  head_repository: { full_name: repository },
  status: "completed",
  conclusion: "success",
  html_url: `https://github.com/${repository}/actions/runs/123`,
};

function lookup(
  t,
  { runs = [success], response, code = 0, ref = "refs/heads/predeploy" } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-ci-reuse-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin"),
    input = join(directory, "response.json"),
    output = join(directory, "output"),
    request = join(directory, "request.json");
  mkdirSync(bin);
  writeFileSync(input, response ?? JSON.stringify({ workflow_runs: runs }));
  const cli = join(bin, "gh");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CI_REQUEST, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.CI_RESPONSE));
process.exit(Number(process.env.CI_API_CODE));
`,
  );
  chmodSync(cli, 0o755);
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REF: ref,
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "456",
      GITHUB_OUTPUT: output,
      CI_REQUEST: request,
      CI_RESPONSE: input,
      CI_API_CODE: String(code),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    result,
    reused: readFileSync(output, "utf8").trim(),
    request: existsSync(request)
      ? JSON.parse(readFileSync(request, "utf8"))
      : null,
  };
}

test("predeploy reuses a completed CI success from another branch for the exact commit", (t) => {
  const result = lookup(t);
  assert.equal(result.reused, "reused=true");
  assert.match(result.result.stdout, new RegExp(success.html_url));
  assert.ok(
    result.request.includes(
      `repos/${repository}/actions/workflows/ci.yml/runs`,
    ),
  );
  for (const filter of [
    `head_sha=${sha}`,
    "event=push",
    "status=success",
    "per_page=100",
  ])
    assert.ok(result.request.includes(filter), filter);
  assert.deepEqual(result.request.slice(0, 3), ["api", "--method", "GET"]);
});

test("non-predeploy pushes run tests without querying workflow history", (t) => {
  const result = lookup(t, { ref: "refs/heads/feat/another-branch" });
  assert.equal(result.reused, "reused=false");
  assert.equal(result.request, null);
});

for (const [name, patch] of [
  ["different commit", { head_sha: "b".repeat(40) }],
  [
    "different repository",
    { head_repository: { full_name: "someone/sortsys" } },
  ],
  ["different workflow", { path: ".github/workflows/publish-containers.yml" }],
  ["pull request merge result", { event: "pull_request" }],
  ["running attempt", { status: "in_progress", conclusion: null }],
  ["queued attempt", { status: "queued", conclusion: null }],
  ["failure", { conclusion: "failure" }],
  ["cancelled attempt", { conclusion: "cancelled" }],
  ["skipped workflow", { conclusion: "skipped" }],
  ["timeout", { conclusion: "timed_out" }],
  ["current run", { id: 456 }],
  ["missing source repository", { head_repository: null }],
  ["missing run reference", { html_url: null }],
])
  test(`does not reuse a ${name}`, (t) => {
    assert.equal(
      lookup(t, { runs: [{ ...success, ...patch }] }).reused,
      "reused=false",
    );
  });

test("no matching success runs tests", (t) => {
  assert.equal(lookup(t, { runs: [] }).reused, "reused=false");
});

test("a later failure does not discard an earlier completed success for the same commit", (t) => {
  assert.equal(
    lookup(t, {
      runs: [{ ...success, id: 321, conclusion: "failure" }, success],
    }).reused,
    "reused=true",
  );
});

for (const [name, options] of [
  ["API failure", { code: 1 }],
  ["malformed JSON", { response: "not JSON" }],
  ["unexpected API response", { response: "{}" }],
])
  test(`${name} falls back to running tests`, (t) => {
    const result = lookup(t, options);
    assert.equal(result.reused, "reused=false");
    assert.match(
      result.result.stdout,
      /Could not verify a previous CI success/,
    );
  });

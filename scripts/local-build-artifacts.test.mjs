import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("local dependencies and generated webapp PWA output are not versioned", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  assert.deepEqual(tracked.filter((path) => /(^|\/)node_modules(\/|$)/.test(path) || path.startsWith("sortsys-webapp-v2/dist/")), []);
});

test("ignore rules cover dependency directories, cache symlinks and PWA output", () => {
  for (const path of ["node_modules", "sortsys-webapp-v2/node_modules", "sortsys-webapp-v2/dist/sw.js"]) {
    const ignored = execFileSync("git", ["check-ignore", "--no-index", "--", path], { cwd: root, encoding: "utf8" }).trim();
    assert.equal(ignored, path);
  }
});

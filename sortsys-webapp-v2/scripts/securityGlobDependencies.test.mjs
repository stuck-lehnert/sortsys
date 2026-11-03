import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import test from "node:test";

const require = createRequire(import.meta.url);
const excelRequire = createRequire(require.resolve("exceljs"));
const root = new URL("../", import.meta.url);

function runIsolated(source) {
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", source], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

// GHSA-g3hv-75wg-m249: keep the hostile pattern in a process we can terminate.
test("minimatch bounds globstar-parent amplification and large-set deduplication", () => {
  runIsolated(`
    const assert = require("node:assert/strict");
    const { Minimatch } = require("minimatch");
    const pattern = Array(30).fill("**/../a/b").join("/");
    const expanded = new Minimatch(pattern, {
      optimizationLevel: 2, braceExpandMax: 64,
    });
    assert.equal(expanded.set.length, 64);
    const large = new Minimatch("{x,*}/{0..999}", { optimizationLevel: 2 });
    assert.equal(large.set.length, 2000);
    assert.equal(large.match("y/999"), true);
    assert.equal(large.match(".y/5"), false);
  `);
});

test("glob, filelist and archiver preserve file matching with patched minimatch", async t => {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-security-glob-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "nested"));
  for (const name of ["root.txt", "nested/entry.txt", "nested/other.csv"]) {
    writeFileSync(join(directory, name), name);
  }
  const pattern = "**/*.{txt,csv}";
  const expected = ["nested/entry.txt", "nested/other.csv", "root.txt"];
  const glob = require("glob");
  assert.deepEqual(glob.sync(pattern, { cwd: directory, nodir: true }).sort(), expected);
  const { FileList } = require("filelist");
  const files = new FileList(join(directory, pattern)).toArray();
  assert.deepEqual(files.map(file => relative(directory, file)).sort(), expected);

  // Archiver drives readdir-glob, another consumer formerly on minimatch 5.
  const archive = excelRequire("archiver")("zip");
  const contents = buffer(archive);
  archive.glob(pattern, { cwd: directory, ignore: "**/*.csv" });
  await archive.finalize();
  const zip = await require("jszip").loadAsync(await contents);
  const archived = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
  assert.deepEqual(archived, ["nested/entry.txt", "root.txt"]);
  assert.equal(await zip.file("nested/entry.txt").async("string"), "nested/entry.txt");
});

test("ExcelJS exports and reloads spreadsheets after its transitive glob update", async () => {
  const { Workbook, stream } = require("exceljs");
  const workbook = new Workbook();
  workbook.addWorksheet("Export").addRows([["Artikel", "Menge"], ["MEP-it", 2]]);
  const bytes = await workbook.xlsx.writeBuffer();
  const reloaded = new Workbook();
  await reloaded.xlsx.load(bytes);
  assert.deepEqual(reloaded.getWorksheet("Export").getRow(2).values.slice(1), ["MEP-it", 2]);

  // Streaming writes use archiver; streaming reads use unzipper.
  const output = new PassThrough();
  const contents = buffer(output);
  const streaming = new stream.xlsx.WorkbookWriter({ stream: output, useSharedStrings: true });
  streaming.addWorksheet("Streaming").addRow(["MEP-it", 2]).commit();
  await streaming.commit();
  const reader = new stream.xlsx.WorkbookReader(Readable.from([await contents]));
  const rows = [];
  for await (const worksheet of reader) {
    for await (const row of worksheet) rows.push(row.values.slice(1));
  }
  assert.deepEqual(rows, [["MEP-it", 2]]);
});

// GHSA-gcqx-w48m-w2h4 has no patched release. Its only consumer clones
// hardcoded Rollup defaults during module loading, before accepting any options.
// Reassess the Dependabot exception if the dependency graph or call path changes.
test("deepmerge remains confined to the build-time Rollup defaults clone", () => {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const consumers = Object.entries(lock.packages)
    .filter(([, pkg]) => pkg.dependencies?.deepmerge);
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0][0], "node_modules/@rollup/plugin-node-resolve");
  assert.equal(consumers[0][1].dev, true);
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path.split("node_modules/").at(-1) === "deepmerge") {
      assert.equal(pkg.dev, true, path);
    }
  }
  const bun = require("typescript").parseConfigFileTextToJson(
    "bun.lock", readFileSync(new URL("bun.lock", root), "utf8"),
  );
  assert.equal(bun.error, undefined);
  const bunConsumers = Object.entries(bun.config.packages)
    .filter(([, record]) => (record[2] ?? record[1])?.dependencies?.deepmerge)
    .map(([name]) => name);
  assert.deepEqual(bunConsumers, ["@rollup/plugin-node-resolve"]);

  runIsolated(`
    const assert = require("node:assert/strict");
    const mergePath = require.resolve("deepmerge");
    const merge = require(mergePath);
    const calls = [];
    require.cache[mergePath].exports = (...args) => {
      calls.push(args);
      return merge(...args);
    };
    const { nodeResolve } = require("@rollup/plugin-node-resolve");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], {});
    assert.deepEqual(calls[0][1], {
      dedupe: [], extensions: [".mjs", ".js", ".json", ".node"],
      resolveOnly: [], moduleDirectories: ["node_modules"], modulePaths: [],
      ignoreSideEffectsForRoot: false, allowExportsFolderMapping: true,
    });
    nodeResolve(JSON.parse('{"session":null,"__proto__":{"admin":true}}'));
    assert.equal(calls.length, 1, "plugin options must never reach deepmerge");
    assert.equal({}.admin, undefined);
  `);
});

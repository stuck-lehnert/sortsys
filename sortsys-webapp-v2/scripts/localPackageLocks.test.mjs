import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = new URL("../../", import.meta.url);
const readJson = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const npmLock = readJson("sortsys-webapp-v2/package-lock.json");
const bunLockText = readFileSync(new URL("sortsys-webapp-v2/bun.lock", root), "utf8");
const parsed = ts.parseConfigFileTextToJson("bun.lock", bunLockText);
assert.equal(parsed.error, undefined, "Bun lock must parse as JSON with trailing commas");
const bunLock = parsed.config;
const fields = ["dependencies", "devDependencies", "peerDependencies"];

for (const directory of ["sortsys-api-v2/client", "sortsys-dwgviewer", "sortsys-react-components"]) {
  const manifest = readJson(`${directory}/package.json`);
  test(`${manifest.name}: npm local-package metadata matches the manifest`, () => {
    const metadata = npmLock.packages[`../${directory}`];
    assert.ok(metadata);
    for (const field of fields) assert.deepEqual(metadata[field] ?? {}, manifest[field] ?? {}, field);
  });
  test(`${manifest.name}: Bun local-package metadata matches the manifest`, () => {
    const record = bunLock.packages[manifest.name];
    assert.ok(record);
    assert.equal(record[0], `${manifest.name}@file:../${directory}`);
    for (const field of fields) assert.deepEqual(record[1][field] ?? {}, manifest[field] ?? {}, field);
  });
}

test("published client does not install development-only type packages", () => {
  const source = readJson("sortsys-api-v2/client/package.json");
  const built = readJson("sortsys-api-v2/client/dist/package.json");
  assert.deepEqual(built.dependencies, source.dependencies);
  assert.ok(Object.keys(built.dependencies).every(name => !name.startsWith("@types/")));
  assert.equal(source.devDependencies["@types/node"], "^24");
  for (const field of fields) assert.equal(source[field]?.["@types/send"], undefined);
});

test("published client declarations typecheck without ambient Node or Bun types", () => {
  const file = fileURLToPath(new URL("sortsys-api-v2/client/package-consumer.ts", root));
  const source = 'import type { Client, QueryPath } from "./dist/index.js";\ndeclare const client: Client;\nconst path: QueryPath = "ping";\nvoid client; void path;\n';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => name === file
    ? ts.createSourceFile(name, source, languageVersion, true)
    : originalGetSourceFile(name, languageVersion, ...rest);
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
});

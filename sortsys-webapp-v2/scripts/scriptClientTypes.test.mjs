import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import {
  generateScriptClientTypes,
  scriptClientTypesPath,
  writeScriptClientTypes,
} from "./generate-script-client-types.mjs";

function templateConstant(source, name) {
  const parsed = ts.createSourceFile(
    "fixture.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(parsed) !== name) continue;
      assert.ok(ts.isNoSubstitutionTemplateLiteral(declaration.initializer));
      return declaration.initializer.text;
    }
  }
  throw new Error(`Missing declaration: ${name}`);
}

const apiTypes = templateConstant(
  await readFile(scriptClientTypesPath, "utf8"),
  "SCRIPT_CLIENT_TYPES",
);
// Compile the exact ambient declarations installed by the production editor.
const bridgeTypes = templateConstant(
  await readFile(
    new URL("../app/components/ScriptEditor.tsx", import.meta.url),
    "utf8",
  ),
  "SCRIPT_TYPES",
);

function diagnostics(source) {
  const files = new Map([
    ["/sortsys/client-script.mjs", source],
    ["/node_modules/@sortsys/v2-client/index.d.ts", apiTypes],
    ["/sortsys-script-env.d.ts", bridgeTypes],
  ]);
  const options = {
    allowJs: true,
    checkJs: true,
    allowNonTsExtensions: true,
    lib: ["lib.es2022.d.ts"],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    // Unlike the editor, check the declaration bodies too: Node/RxJS remnants
    // or unresolved references must not be hidden behind skipLibCheck.
    skipLibCheck: false,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const directoryExists = host.directoryExists.bind(host);
  host.readFile = (path) => files.get(path) ?? read(path);
  host.fileExists = (path) => files.has(path) || exists(path);
  host.directoryExists = (path) =>
    [...files.keys()].some(
      (file) => dirname(file) === path || file.startsWith(`${path}/`),
    ) || directoryExists(path);
  host.getSourceFile = (path, languageVersion) => {
    const content = host.readFile(path);
    if (content === undefined) return undefined;
    return ts.createSourceFile(path, content, languageVersion, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

test("script declarations match the installed API and compile without Node, RxJS or an RPC framework", async () => {
  await writeScriptClientTypes({ check: true });
  const result = diagnostics(`
const { client } = await import("sortsys-client");
const [note] = await client.query("deliveryNotes.get", { id: "1" });
if (note) {
  note.autoId.toFixed();
  note.specialRecords[0]?.pricePerUnit?.toFixed();
}
await client.mutate("deliveryNotes.delete", { id: "1", expectedRevision: "2" });
const [organization] = await client.query("settings.organization.get", undefined);
organization?.address?.streetAddress.toUpperCase();
await client.invalidate("deliveryNotes.list");
await client.invalidateCascading("deliveryNotes.list");
`);
  assert.deepEqual(result, []);
});

for (const [name, source, message] of [
  [
    "removed procedures",
    'await client.query("projects.files.officeConfig", { id: "1" });',
    /not assignable/,
  ],
  [
    "operator controls",
    'await client.query("admin.users.list", undefined);',
    /not assignable/,
  ],
  [
    "wrong input values",
    'await client.mutate("deliveryNotes.delete", { id: "1", expectedRevision: 2 });',
    /number.*not assignable.*string/,
  ],
  [
    "unknown input fields",
    'await client.mutate("deliveryNotes.delete", { id: "1", plaintext: "leak" });',
    /plaintext/,
  ],
  [
    "nonexistent output fields",
    'const [note] = await client.query("deliveryNotes.get", { id: "1" }); note?.plaintext;',
    /plaintext.*does not exist/,
  ],
  [
    "unsupported bridge methods",
    'await client.login("password");',
    /login.*does not exist/,
  ],
]) {
  test(`script editor rejects ${name}`, () => {
    const result = diagnostics(
      'const { client } = await import("sortsys-client");\n' + source,
    );
    assert.equal(result.length, 1, JSON.stringify(result));
    assert.equal(result[0].file, "/sortsys/client-script.mjs");
    assert.match(result[0].message, message);
  });
}

test("generation detects contract drift, preserves template types and fails on missing client aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sortsys-script-types-"));
  try {
    const contractPath = join(directory, "contract.d.ts");
    const outputPath = join(directory, "generated.ts");
    const contract =
      "export type Route = `scope:${string}`;\nexport interface QueryInputs { current: { revision: string }; }\n";
    await writeFile(contractPath, contract);
    await writeScriptClientTypes({ contractPath, outputPath });
    await writeScriptClientTypes({ contractPath, outputPath, check: true });
    const original = await readFile(outputPath, "utf8");
    assert.match(
      templateConstant(original, "SCRIPT_CLIENT_TYPES"),
      /`scope:\$\{string\}`/,
    );
    await writeFile(
      contractPath,
      contract.replace("revision: string", "revision: number"),
    );
    await assert.rejects(
      writeScriptClientTypes({ contractPath, outputPath, check: true }),
      /veraltet/,
    );
    assert.equal(
      await readFile(outputPath, "utf8"),
      original,
      "check must not overwrite the reviewed declarations",
    );
    await writeScriptClientTypes({ contractPath, outputPath });
    await writeScriptClientTypes({ contractPath, outputPath, check: true });
    const clientPath = join(directory, "client.d.ts");
    await writeFile(clientPath, "export type CacheMode = string;\n");
    await assert.rejects(
      generateScriptClientTypes({ contractPath, clientPath }),
      /Fehlende API-Deklaration: QueryPath/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

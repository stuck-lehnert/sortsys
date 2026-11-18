import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const clientDirectory = dirname(require.resolve("@sortsys/v2-client"));
export const scriptClientTypesPath = fileURLToPath(
  new URL("../app/lib/scriptClientTypes.generated.ts", import.meta.url),
);
const clientAliases = new Set([
  "CacheMode",
  "QueryPath",
  "MutatePath",
  "QueryInput",
  "MutateInput",
  "QueryOutput",
  "MutateOutput",
]);

function declarations(source, fileName, selectedNames) {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  if (parsed.parseDiagnostics.length) {
    throw new Error(`Ungültige API-Deklarationen in ${fileName}`);
  }
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const found = new Set();
  const result = [];
  for (const statement of parsed.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement) &&
      !ts.isInterfaceDeclaration(statement)
    )
      continue;
    const name = statement.name.text;
    if (selectedNames && !selectedNames.has(name)) continue;
    if (found.has(name)) throw new Error(`Doppelte API-Deklaration: ${name}`);
    found.add(name);
    result.push(printer.printNode(ts.EmitHint.Unspecified, statement, parsed));
  }
  for (const name of selectedNames ?? []) {
    if (!found.has(name)) throw new Error(`Fehlende API-Deklaration: ${name}`);
  }
  return result.join("\n\n");
}

/** Only the script bridge's input/output types belong in Monaco. Runtime
 * methods, RxJS and Node declarations are deliberately not copied. */
export async function generateScriptClientTypes({
  contractPath = join(clientDirectory, "generated/contract.d.ts"),
  clientPath = join(clientDirectory, "index.d.ts"),
} = {}) {
  const [contract, client] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(clientPath, "utf8"),
  ]);
  const source =
    [
      declarations(contract, contractPath),
      declarations(client, clientPath, clientAliases),
    ].join("\n\n") + "\n";
  const escaped = source
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${");
  return [
    "// Generiert mit node scripts/generate-script-client-types.mjs. Nicht von Hand bearbeiten.",
    "// Quelle: Deklarationen des installierten @sortsys/v2-client.",
    `export const SCRIPT_CLIENT_TYPES = \`\n${escaped}\`;`,
    "",
  ].join("\n");
}

export async function writeScriptClientTypes({
  check = false,
  outputPath = scriptClientTypesPath,
  ...inputs
} = {}) {
  const generated = await generateScriptClientTypes(inputs);
  if (!check) {
    await writeFile(outputPath, generated);
    return;
  }
  const current = await readFile(outputPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== generated) {
    throw new Error(
      "Die Skripteditor-Typen sind veraltet. In sortsys-webapp-v2 `npm run scripts:generate-client-types` ausführen.",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.some((argument) => argument !== "--check") || args.length > 1) {
      throw new Error(
        "Aufruf: node scripts/generate-script-client-types.mjs [--check]",
      );
    }
    await writeScriptClientTypes({ check: args.includes("--check") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

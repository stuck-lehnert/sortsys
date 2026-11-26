import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const moduleId = "virtual:sortsys-script-client-types";
const resolvedId = `\0${moduleId}`;
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
export async function loadScriptClientTypes(contractPath, clientPath) {
  const [contract, client] = await Promise.all([
    readFile(contractPath, "utf8"),
    readFile(clientPath, "utf8"),
  ]);

  return [
    declarations(contract, contractPath),
    declarations(client, clientPath, clientAliases),
  ].join("\n\n") + "\n";
}

export function scriptClientTypesPlugin() {
  return {
    name: "sortsys-script-client-types",
    resolveId(id) {
      if (id === moduleId) return resolvedId;
    },
    async load(id) {
      if (id !== resolvedId) return;

      const directory = dirname(require.resolve("@sortsys/v2-client"));
      const contractPath = join(directory, "generated/contract.d.ts");
      const clientPath = join(directory, "index.d.ts");
      this.addWatchFile(contractPath);
      this.addWatchFile(clientPath);

      const source = await loadScriptClientTypes(contractPath, clientPath);
      return `export default ${JSON.stringify(source)};`;
    },
  };
}

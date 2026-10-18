import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { generateTypedContract } from "./typed_contract.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(
  path.join(root, "sortsys-webapp-v2/package.json"),
);
const ts = require("typescript");
const sourcePath = path.join(
  root,
  "sortsys-api-v2/client/dist/generated/contract.d.ts",
);
const text = fs.readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(
  sourcePath,
  text,
  ts.ScriptTarget.Latest,
  true,
);
const checkOnly = process.argv.includes("--check");

if (source.parseDiagnostics.length) {
  throw new Error("CONTRACT_PARSE_FAILED");
}

const keywordKinds = new Map([
  [ts.SyntaxKind.StringKeyword, "string"],
  [ts.SyntaxKind.NumberKeyword, "number"],
  [ts.SyntaxKind.BooleanKeyword, "boolean"],
  [ts.SyntaxKind.BigIntKeyword, "bigint"],
  [ts.SyntaxKind.UnknownKeyword, "unknown"],
  [ts.SyntaxKind.AnyKeyword, "unknown"],
  [ts.SyntaxKind.VoidKeyword, "undefined"],
  [ts.SyntaxKind.UndefinedKeyword, "undefined"],
  [ts.SyntaxKind.NullKeyword, "null"],
]);

function literalShape(node) {
  const literal = node.literal;

  if (literal.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "null" };
  }

  if (literal.kind === ts.SyntaxKind.TrueKeyword) {
    return { kind: "literal", value: true };
  }

  if (literal.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "literal", value: false };
  }

  if (ts.isNumericLiteral(literal)) {
    return { kind: "literal", value: Number(literal.text) };
  }

  if (ts.isStringLiteral(literal)) {
    return { kind: "literal", value: literal.text };
  }

  throw new Error(`UNSUPPORTED_LITERAL:${node.getText(source)}`);
}

function referenceShape(node) {
  const name = node.typeName.getText(source);

  if (name === "Date") {
    return { kind: "date" };
  }

  if (name === "Array" || name === "ReadonlyArray") {
    return { kind: "array", item: shape(node.typeArguments?.[0]) };
  }

  if (name === "Record") {
    return { kind: "record", item: shape(node.typeArguments?.[1]) };
  }

  return { kind: "ref", name };
}

function objectShape(node) {
  const fields = {};

  for (const member of node.members) {
    if (ts.isIndexSignatureDeclaration(member)) {
      return { kind: "record", item: shape(member.type) };
    }

    if (!ts.isPropertySignature(member) || !member.name) {
      throw new Error(`UNSUPPORTED_MEMBER:${member.getText(source)}`);
    }

    const name = ts.isStringLiteral(member.name)
      ? member.name.text
      : member.name.getText(source);
    fields[name] = {
      optional: !!member.questionToken,
      type: shape(member.type),
    };
  }

  return { kind: "object", fields };
}

function shape(node) {
  if (!node) {
    throw new Error("MISSING_CONTRACT_TYPE");
  }

  if (keywordKinds.has(node.kind)) {
    return { kind: keywordKinds.get(node.kind) };
  }

  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return shape(node.type);
  }

  if (ts.isArrayTypeNode(node)) {
    return { kind: "array", item: shape(node.elementType) };
  }

  if (ts.isUnionTypeNode(node)) {
    return { kind: "union", variants: node.types.map(shape) };
  }

  if (ts.isLiteralTypeNode(node)) {
    return literalShape(node);
  }

  if (ts.isTypeReferenceNode(node)) {
    return referenceShape(node);
  }

  if (ts.isMappedTypeNode(node)) {
    return { kind: "record", item: shape(node.type) };
  }

  if (ts.isTypeLiteralNode(node)) {
    return objectShape(node);
  }

  throw new Error(
    `UNSUPPORTED_CONTRACT_TYPE:${ts.SyntaxKind[node.kind]}:${node.getText(source)}`,
  );
}

function contractTypes() {
  const types = {};

  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement)) {
      const declaration = statement.getText(source).slice(0, 80);

      throw new Error(`UNSUPPORTED_DECLARATION:${declaration}`);
    }

    types[statement.name.text] = shape(statement.type);
  }

  return types;
}

function contractProcedures(types) {
  const procedures = [];
  const tables = [
    ["query", "QueryInputs", "QueryOutputs"],
    ["mutation", "MutationInputs", "MutationOutputs"],
  ];

  for (const [kind, inputName, outputName] of tables) {
    const inputs = types[inputName];
    const outputs = types[outputName];

    if (inputs?.kind !== "object" || outputs?.kind !== "object") {
      throw new Error("INVALID_PROCEDURE_TABLE");
    }

    const inputNames = Object.keys(inputs.fields).sort().join("\n");
    const outputNames = Object.keys(outputs.fields).sort().join("\n");

    if (inputNames !== outputNames) {
      throw new Error("PROCEDURE_TABLE_MISMATCH");
    }

    for (const [name, input] of Object.entries(inputs.fields)) {
      procedures.push({
        name,
        kind,
        input: input.type,
        output: outputs.fields[name].type,
      });
    }

    delete types[inputName];
    delete types[outputName];
  }

  return procedures;
}

function validateReferences(node, types) {
  if (node.kind === "ref" && !types[node.name]) {
    throw new Error(`UNKNOWN_CONTRACT_REFERENCE:${node.name}`);
  }

  if (node.kind === "object") {
    for (const field of Object.values(node.fields)) {
      validateReferences(field.type, types);
    }
  } else if (node.kind === "array" || node.kind === "record") {
    validateReferences(node.item, types);
  } else if (node.kind === "union") {
    for (const variant of node.variants) {
      validateReferences(variant, types);
    }
  }
}

function readableGeneratedSource(formatted) {
  const lines = formatted.trimEnd().split("\n");
  const result = [];

  for (const [index, line] of lines.entries()) {
    result.push(line);
    const closesConstruct = /^\s*}[),;]*$/.test(line);
    const next = lines[index + 1];

    if (closesConstruct && next !== undefined && next.trim() !== "") {
      const connectedClause = /^\s*(else|catch|finally|while)\b/.test(next);

      if (!connectedClause) {
        result.push("");
      }
    }
  }

  return result.join("\n") + "\n";
}

function formatTypedSources(results) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "sortsys-dart-models-"),
  );

  try {
    return results.map(([name, content]) => {
      if (!name.endsWith(".dart")) {
        return [name, content];
      }

      const file = path.join(temporary, name);
      fs.writeFileSync(file, content);
      const formatted = spawnSync("dart", ["format", file], {
        encoding: "utf8",
      });

      if (formatted.status !== 0) {
        throw new Error(
          `DART_MODEL_FORMAT_FAILED:${name}\n${formatted.stderr}`,
        );
      }

      const finalSource = readableGeneratedSource(
        fs.readFileSync(file, "utf8"),
      );

      return [name, finalSource];
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function writeResults(results) {
  const target = path.join(root, "sortsys-client/lib/api/generated");
  fs.mkdirSync(target, { recursive: true });

  for (const [name, content] of results) {
    const file = path.join(target, name);

    if (checkOnly) {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) {
        throw new Error(`STALE_CONTRACT:${name}`);
      }
    } else {
      fs.writeFileSync(file, content);
    }
  }
}

const types = contractTypes();
const procedures = contractProcedures(types);

for (const type of Object.values(types)) {
  validateReferences(type, types);
}

for (const procedure of procedures) {
  validateReferences(procedure.input, types);
  validateReferences(procedure.output, types);
}

const contractSha256 = crypto.createHash("sha256").update(text).digest("hex");
const data = { contractSha256, types, procedures };
const json = JSON.stringify(data, null, 2) + "\n";
const dart =
  "// Generated from the Rust API contract. Run tool/generate_contract.mjs.\n" +
  `const contractJson = r'''${JSON.stringify(data)}''';\n`;
const typed = formatTypedSources(generateTypedContract(data));

writeResults([["contract.json", json], ["contract.g.dart", dart], ...typed]);

const queries = procedures.filter(
  (procedure) => procedure.kind === "query",
).length;
const mutations = procedures.filter(
  (procedure) => procedure.kind === "mutation",
).length;
console.log(
  `Contract: ${queries} queries, ${mutations} mutations; SHA256 ${contractSha256}.`,
);
console.log(
  "Generated typed objects, records, enums/unions and endpoint descriptors.",
);

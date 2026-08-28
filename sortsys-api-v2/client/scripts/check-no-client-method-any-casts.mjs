import { readdir, readFile } from "node:fs/promises";
import ts from "typescript";

const guardedMethodNames = new Set([
  "invalidate",
  "invalidateCascading",
  "login",
  "logout",
  "mutate",
  "query",
  "streamQuery",
]);

const sourceRoots = [
  new URL("../src/", import.meta.url),
  new URL("../../../sortsys-webapp-v2/app/", import.meta.url),
];

async function listTypeScriptFiles(root) {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];

  for (const entry of entries) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), root);

    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(url));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(url);
    }
  }

  return files;
}

function unwrapExpression(expression) {
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }

  return expression;
}

function assertedMethodName(node) {
  const expression = unwrapExpression(node.expression);

  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }

  return null;
}

function findViolations(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];

  function visit(node) {
    const isAssertion = ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);

    if (
      isAssertion
      && node.type.kind === ts.SyntaxKind.AnyKeyword
      && guardedMethodNames.has(assertedMethodName(node))
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({
        fileName,
        line: position.line + 1,
        column: position.character + 1,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function verifyRule() {
  const rejected = findViolations("(client.mutate as any)('projects.create', {});", "rejected.ts");
  const disguised = findViolations("(<any>(client.query as unknown))('projects.list');", "disguised.ts");
  const accepted = findViolations("client.mutate('projects.create', input);", "accepted.ts");

  if (rejected.length !== 1 || disguised.length !== 1 || accepted.length !== 0) {
    throw new Error("no-client-method-any-casts rule self-check failed");
  }
}

verifyRule();

const files = (await Promise.all(sourceRoots.map(listTypeScriptFiles))).flat();
const violations = [];

for (const file of files) {
  violations.push(...findViolations(await readFile(file, "utf8"), file.pathname));
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(
      `${violation.fileName}:${violation.line}:${violation.column}: `
      + "Do not cast typed client methods to any. Use the generated contract or an explicit dynamic client method.",
    );
  }

  process.exit(1);
}

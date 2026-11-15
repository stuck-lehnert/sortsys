#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = new URL("sortsys-webapp-v2/schema/business.json", root);
const destination = new URL(
  "sortsys-webapp-v2/app/generated/browser-schema.generated.json",
  root,
);
const model = JSON.parse(await readFile(source, "utf8"));

assert.equal(model.format, "sortsys-browser-schema-v2");
assert.ok(model.enums && typeof model.enums === "object");
assert.ok(Array.isArray(model.tables) && model.tables.length > 0);
assert.ok(!Object.hasOwn(model, "fingerprint"));

function assertDistinctNames(values, label) {
  const names = new Set();
  for (const value of values) {
    assert.match(value.name, /^[a-z_][a-z_0-9]*$/, label);
    assert.ok(!names.has(value.name), `${label}: ${value.name} is duplicated`);
    names.add(value.name);
  }
  return names;
}

assertDistinctNames(model.tables, "Business table");
for (const table of model.tables) {
  const columns = assertDistinctNames(table.columns, `Columns in ${table.name}`);
  assert.ok(table.constraints.some(constraint => constraint.kind === "p"));
  for (const constraint of table.constraints) {
    for (const column of constraint.columns) {
      assert.ok(columns.has(column), `${table.name}: unknown column ${column}`);
    }
  }
}

// The browser's logical model is authoritative. A schema change no longer
// requires starting a PostgreSQL instance or replaying former migrations.
const fingerprint = createHash("sha256")
  .update("sortsys/browser-schema/v2\0")
  .update(JSON.stringify(model))
  .digest("hex");
const output = JSON.stringify({ ...model, fingerprint }, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = await readFile(destination, "utf8").catch(() => "");
  assert.equal(
    current,
    output,
    "Browser schema is stale. Run node scripts/generate-browser-schema.mjs",
  );
} else {
  await writeFile(destination, output);
}

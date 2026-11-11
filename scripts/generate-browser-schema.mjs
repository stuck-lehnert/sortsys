#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("../", import.meta.url);
const manifest = await readFile(new URL("sortsys-api-v2/rust-api/src/migrations_generated.rs", root), "utf8");
const files = [...manifest.matchAll(/include_str!\("\.\.\/migrations\/([^"/]+\.sql)"\)/g)].map(match => match[1]);
if (!files.length || new Set(files).size !== files.length) throw new Error("Invalid migration manifest");
const hash = createHash("sha256");
hash.update("sortsys/browser-schema/v2\0").update(await readFile(new URL("sortsys-api-v2/rust-api/schema/browser_catalog.sql", root))).update("\0");
for (const file of files) {
  // Authentication/key persistence stays in the API. Business schema remains
  // derived from the same authoritative SQL files; never maintain a copy by hand.
  if (/^\d{12}_zerotrust(?:_|\.sql$)/.test(file)) continue;
  hash.update(file).update("\0").update(await readFile(new URL(`sortsys-api-v2/rust-api/migrations/${file}`, root))).update("\0");
}
const schema = JSON.parse(await readFile(new URL("sortsys-api-v2/rust-api/schema/business.generated.json", root), "utf8"));
if (schema.format !== "sortsys-browser-schema-v2" || schema.fingerprint !== hash.digest("hex")) {
  throw new Error("Business schema is stale. Run generate_browser_schema against an isolated PostgreSQL test instance, then node scripts/generate-browser-schema.mjs");
}
const output = JSON.stringify(schema, null, 2) + "\n";
const destination = new URL("sortsys-webapp-v2/app/generated/browser-schema.generated.json", root);
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8").catch(() => "") !== output) {
    throw new Error("Browser schema is stale. Run node scripts/generate-browser-schema.mjs");
  }
} else { await writeFile(destination, output); }

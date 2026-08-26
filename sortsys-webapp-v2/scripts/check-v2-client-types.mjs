import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, root);
    if (entry.isDirectory()) {
      files.push(...await listFiles(url));
    } else if (
      entry.isFile()
      && (entry.name.endsWith(".rs") || entry.name.endsWith(".ts"))
    ) {
      files.push(url);
    }
  }

  return files;
}

async function hashApiSource() {
  const roots = [
    new URL("../../sortsys-api-v2/rust-api/src/", import.meta.url),
    new URL("../../sortsys-api-v2/client/src/generated/contract.ts", import.meta.url),
  ];
  const hash = createHash("sha256");
  const files = [];

  for (const root of roots) {
    const info = await stat(root);
    if (info.isDirectory()) {
      files.push(...await listFiles(root));
    } else {
      files.push(root);
    }
  }

  files.sort((left, right) => left.pathname.localeCompare(right.pathname));
  const repoRoot = new URL("../../sortsys-api-v2/", import.meta.url);
  for (const file of files) {
    hash.update(relative(repoRoot.pathname, file.pathname));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

const pkgUrl = new URL("../node_modules/@sortsys/v2-client/package.json", import.meta.url);
const installedPkg = JSON.parse(await readFile(pkgUrl, "utf8"));
const expected = await hashApiSource();
const actual = installedPkg.sortsysApiSourceHash;

if (actual !== expected) {
  console.error("@sortsys/v2-client types are stale. Run `npm run client:build` in sortsys-api-v2, then `npm install` in sortsys-webapp-v2.");
  console.error(`expected ${expected}`);
  console.error(`actual   ${actual ?? "<missing>"}`);
  process.exit(1);
}

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
    } else if (entry.isFile()) {
      files.push(url);
    }
  }

  return files;
}

async function hashFiles(roots, base) {
  const files = [];

  for (const root of roots) {
    const info = await stat(root);
    files.push(...(info.isDirectory() ? await listFiles(root) : [root]));
  }

  files.sort((left, right) => left.pathname.localeCompare(right.pathname));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(base.pathname, file.pathname));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function hashApiContract() {
  const clientRoot = new URL("../", import.meta.url);

  return hashFiles([
    new URL("../src/generated/contract.ts", import.meta.url),
  ], clientRoot);
}

export async function hashClientBuildInputs() {
  const clientRoot = new URL("../", import.meta.url);

  return hashFiles([
    new URL("../src/", import.meta.url),
    new URL("../scripts/", import.meta.url),
    new URL("../package.json", import.meta.url),
    new URL("../bun.lock", import.meta.url),
    new URL("../tsconfig.json", import.meta.url),
  ], clientRoot);
}

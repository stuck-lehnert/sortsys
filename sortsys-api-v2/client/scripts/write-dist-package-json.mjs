import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
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
    new URL("../../rust-api/src/", import.meta.url),
    new URL("../src/generated/contract.ts", import.meta.url),
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
  const repoRoot = new URL("../../", import.meta.url);
  for (const file of files) {
    hash.update(relative(repoRoot.pathname, file.pathname));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

const pkgRaw = await readFile(new URL("../package.json", import.meta.url), "utf8");
const pkg = JSON.parse(pkgRaw);

const distPkg = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  type: pkg.type ?? "module",
  description: pkg.description,
  main: "./index.js",
  types: "./index.d.ts",
  exports: {
    import: "./index.js",
    types: "./index.d.ts",
    default: "./index.js",
  },
  dependencies: pkg.dependencies ?? {},
  sortsysApiSourceHash: await hashApiSource(),
};

await writeFile(
  new URL("../dist/package.json", import.meta.url),
  `${JSON.stringify(distPkg, null, 2)}\n`,
  "utf8",
);

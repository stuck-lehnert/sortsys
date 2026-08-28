import { readFile, writeFile } from "node:fs/promises";

import {
  hashApiContract,
  hashClientBuildInputs,
} from "./build-fingerprint.mjs";

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
  sortsysApiSourceHash: await hashApiContract(),
  sortsysClientBuildHash: await hashClientBuildInputs(),
};

await writeFile(
  new URL("../dist/package.json", import.meta.url),
  `${JSON.stringify(distPkg, null, 2)}\n`,
  "utf8",
);

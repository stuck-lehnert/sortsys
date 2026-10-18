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
    ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
    "./rpc": { types: "./rpc.d.ts", import: "./rpc.js", default: "./rpc.js" },
    "./contract": { types: "./generated/contract.d.ts" },
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

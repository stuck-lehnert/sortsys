import { access, readFile } from "node:fs/promises";

import { hashClientBuildInputs } from "./build-fingerprint.mjs";

try {
  const distRoot = new URL("../dist/", import.meta.url);
  const distPackage = JSON.parse(
    await readFile(new URL("package.json", distRoot), "utf8"),
  );

  await Promise.all([
    access(new URL("index.js", distRoot)),
    access(new URL("index.d.ts", distRoot)),
  ]);

  const expected = await hashClientBuildInputs();
  if (distPackage.sortsysClientBuildHash !== expected) {
    process.exitCode = 1;
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.error(error);
  }

  process.exitCode = 1;
}

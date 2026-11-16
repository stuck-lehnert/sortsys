import { readFile } from "node:fs/promises";

import {
  hashApiContract,
  hashClientBuildInputs,
} from "../../sortsys-api-v2/client/scripts/build-fingerprint.mjs";

const pkgUrl = new URL(
  "../node_modules/@sortsys/v2-client/dist/package.json",
  import.meta.url,
);
const installedPkg = JSON.parse(await readFile(pkgUrl, "utf8"));
const expected = await hashApiContract();
const actual = installedPkg.sortsysApiSourceHash;

if (actual !== expected) {
  console.error(
    "@sortsys/v2-client types are stale. Run `npm run client:build` in sortsys-api-v2, then `npm install` in sortsys-webapp-v2.",
  );
  console.error(`expected ${expected}`);
  console.error(`actual   ${actual ?? "<missing>"}`);
  process.exit(1);
}

const expectedBuild = await hashClientBuildInputs();
if (installedPkg.sortsysClientBuildHash !== expectedBuild) {
  console.error(
    "Der installierte API-Client enthält einen veralteten Build. Den Client in sortsys-api-v2/client neu bauen und die lokale Abhängigkeit in sortsys-webapp-v2 erneuern.",
  );
  console.error(`expected ${expectedBuild}`);
  console.error(
    `actual   ${installedPkg.sortsysClientBuildHash ?? "<missing>"}`,
  );
  process.exit(1);
}

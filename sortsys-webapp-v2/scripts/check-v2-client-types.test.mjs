import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("the installed-client check rejects changed transport code even when the API contract is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "sortsys-client-build-check-"));
  try {
    const client = join(root, "sortsys-api-v2/client");
    const webapp = join(root, "sortsys-webapp-v2");
    await Promise.all([
      mkdir(join(client, "src/generated"), { recursive: true }),
      mkdir(join(client, "scripts"), { recursive: true }),
      mkdir(join(webapp, "scripts"), { recursive: true }),
      mkdir(join(webapp, "node_modules/@sortsys/v2-client/dist"), {
        recursive: true,
      }),
    ]);
    const check = join(webapp, "scripts/check-v2-client-types.mjs");
    const fingerprint = join(client, "scripts/build-fingerprint.mjs");
    await Promise.all([
      cp(new URL("./check-v2-client-types.mjs", import.meta.url), check),
      cp(
        new URL(
          "../../sortsys-api-v2/client/scripts/build-fingerprint.mjs",
          import.meta.url,
        ),
        fingerprint,
      ),
      writeFile(
        join(client, "src/generated/contract.ts"),
        "export type Input = { id: string };\n",
      ),
      writeFile(join(client, "src/rpc.ts"), "export const queryWindow = 0;\n"),
      writeFile(join(client, "package.json"), '{"type":"module"}\n'),
      writeFile(join(client, "bun.lock"), "locked fixture\n"),
      writeFile(join(client, "tsconfig.json"), "{}\n"),
    ]);
    const hashes = await import(pathToFileURL(fingerprint).href);
    const metadata = {
      sortsysApiSourceHash: await hashes.hashApiContract(),
      sortsysClientBuildHash: await hashes.hashClientBuildInputs(),
    };
    const installed = join(
      webapp,
      "node_modules/@sortsys/v2-client/dist/package.json",
    );
    await writeFile(installed, JSON.stringify(metadata));
    execFileSync(process.execPath, [check]);
    await writeFile(
      join(client, "src/rpc.ts"),
      "export const queryWindow = 4;\n",
    );
    assert.equal(await hashes.hashApiContract(), metadata.sortsysApiSourceHash);
    let result = spawnSync(process.execPath, [check], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /veralteten Build/);
    metadata.sortsysClientBuildHash = await hashes.hashClientBuildInputs();
    await writeFile(installed, JSON.stringify(metadata));
    execFileSync(process.execPath, [check]);
    await writeFile(
      join(client, "src/generated/contract.ts"),
      "export type Input = { id: string; subject?: string };\n",
    );
    result = spawnSync(process.execPath, [check], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /types are stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { writeFile } from "node:fs/promises";
import {
  base64,
  bytes,
  createIdentity,
  digest,
  MigrationInventory,
  migrationSealFrame,
  publicIdentity,
  sign,
} from "../src/index";

const identity = await createIdentity();
const entries = [
  {
    kind: "blob",
    id: "asset:1",
    revision: "0",
    hash: await digest(bytes("Public ciphertext hash")),
  },
  {
    kind: "record",
    id: "patient:1",
    revision: "9223372036854775807",
    hash: await digest(bytes("Another ciphertext")),
  },
];
const source = new MigrationInventory();
for (const entry of entries) source.add(entry);
const target = new MigrationInventory();
const unsigned = {
  tenant: "practice:alpha",
  migration: "migration:1",
  schema: "schema:custom:1",
  generation: "3",
  policyVersion: "17",
  catalogVersion: "9",
  source: source.finish(),
  target: target.finish(),
  author: "doctor:lee",
};
const seal = {
  ...unsigned,
  proof: await sign(
    identity.signingKey.privateKey,
    migrationSealFrame(unsigned),
  ),
};
await writeFile(
  new URL("fixtures/migration-completion.json", import.meta.url),
  JSON.stringify(
    {
      identity: await publicIdentity(identity),
      entries,
      seal,
      frame: base64(migrationSealFrame(seal)),
    },
    null,
    2,
  ) + "\n",
);

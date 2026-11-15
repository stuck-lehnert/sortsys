import { areaKey, bytes, createIdentity, encryptObject, encryptTombstone, publicSigningKey } from "../src/sortsys";
const identity = await createIdentity(), key = await areaKey();
const context = { tenant: "test", scope: "project:2:daily-reports", facet: "master-data" as const, object: "daily-report:2:3", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-tombstones.json", import.meta.url), JSON.stringify({
  notice: "Public synthetic browser protocol vector; no private keys or recovery phrase.",
  signer: await publicSigningKey(identity.signingKey.publicKey),
  initial: await encryptObject(context, bytes('{"name":"Synthetic report"}'), key, identity.signingKey.privateKey),
  deleted: await encryptTombstone({ ...context, revision: "2" }, key, identity.signingKey.privateKey),
}, null, 2) + "\n");

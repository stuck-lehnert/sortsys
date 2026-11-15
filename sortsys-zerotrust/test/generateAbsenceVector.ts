import { areaKey, bytes, createIdentity, encryptObject, encryptTombstone, publicSigningKey, type ObjectContext } from "../src/sortsys";
const identity = await createIdentity(), key = await areaKey();
const context: ObjectContext = { tenant: "test", scope: "absence:2", facet: "master-data", object: "absence:2:request:3", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };
const request = await encryptObject(context, bytes('{"private":"request"}'), key, identity.signingKey.privateKey);
const decisionContext: ObjectContext = { ...context, facet: "personnel", object: "absence:2:decision:3" };
const cases = [
  { envelope: request, action: "create" },
  { envelope: await encryptObject(decisionContext, bytes('{"private":"decision"}'), key, identity.signingKey.privateKey), action: "approve" },
  { envelope: await encryptTombstone({ ...context, revision: "2" }, key, identity.signingKey.privateKey), action: "delete" },
  ...await Promise.all([{ ...context, revision: "2" }, { ...decisionContext, revision: "2" }, { ...decisionContext, scope: "absence:4" },
    { ...decisionContext, facet: "master-data" as const }, { ...context, object: "absence:2:request:3:extra" }].map(async input => ({
    envelope: await encryptObject(input, bytes("{}"), key, identity.signingKey.privateKey), action: null,
  }))),
  { envelope: await encryptTombstone({ ...decisionContext, revision: "2" }, key, identity.signingKey.privateKey), action: null },
];
await Bun.write(new URL("../../sortsys-api-v2/rust-api/tests/fixtures/zerotrust-absences.json", import.meta.url), JSON.stringify({
  notice: "Public synthetic protocol vectors; no private keys or recovery phrase.", signer: await publicSigningKey(identity.signingKey.publicKey), cases,
}, null, 2) + "\n");

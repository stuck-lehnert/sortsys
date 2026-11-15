import { expect, test } from "bun:test";
import { areaKey, base64, bytes, createIdentity, decryptObject, encryptedObject, encryptObject, encryptTombstone, objectFrame, sign, TOMBSTONE_FORMAT, VerifiedStore } from "../src/sortsys";
const context = { tenant: "test", scope: "project:2:daily-reports", facet: "master-data" as const, object: "daily-report:2:3", revision: "2", generation: "1", policyVersion: "1", author: "user:1" };

test("tombstones authenticate an empty body and bind every existing object context", async () => {
  const identity = await createIdentity(), key = await areaKey();
  const value = await encryptTombstone(context, key, identity.signingKey.privateKey);
  expect(value.format).toBe(TOMBSTONE_FORMAT); expect(encryptedObject(value)).toEqual(value);
  expect(await decryptObject(value, context, key, identity.signingKey.publicKey)).toEqual(new Uint8Array(0));
  await expect(encryptTombstone({ ...context, revision: "1" }, key, identity.signingKey.privateKey)).rejects.toThrow();
  await expect(decryptObject({ ...value, format: "sortsys-object-v1" }, context, key, identity.signingKey.publicKey)).rejects.toThrow();
  await expect(decryptObject(value, { ...context, scope: "project:3:daily-reports" }, key, identity.signingKey.publicKey)).rejects.toThrow();
  const body = await encryptObject(context, bytes('{"price":592.00}'), key, identity.signingKey.privateKey);
  const disguised: typeof body = { ...body, format: TOMBSTONE_FORMAT };
  disguised.signature = await sign(identity.signingKey.privateKey, objectFrame(disguised));
  expect(() => encryptedObject(disguised)).toThrow();
  expect(() => encryptedObject({ ...value, ciphertext: base64(new Uint8Array(17)) })).toThrow();
});
test("a verified deletion discards the last visible value and never resurrects older or rewritten data", async () => {
  const identity = await createIdentity(), key = await areaKey();
  const store = new VerifiedStore({ context: { tenant: context.tenant, scope: context.scope, facet: context.facet }, schema: { decode: value => value }, key: async () => key, signer: async () => identity.signingKey.publicKey });
  const first = await encryptObject({ ...context, revision: "1" }, bytes('{"name":"Fenstersanierung"}'), key, identity.signingKey.privateKey);
  expect((await store.receive(context.object, first)).kind).toBe("verified");
  const removed = await encryptTombstone(context, key, identity.signingKey.privateKey);
  expect(await store.receive(context.object, removed)).toEqual({ kind: "deleted", revision: "2" });
  expect(await store.receive(context.object, removed)).toEqual({ kind: "deleted", revision: "2" });
  for (const value of [first, await encryptObject({ ...context, revision: "3" }, bytes('{"name":"Do not restore"}'), key, identity.signingKey.privateKey)]) {
    const result = await store.receive(context.object, value);
    expect(result.kind).toBe("invalid"); if (result.kind === "invalid") expect(result.lastGood).toBeUndefined();
  }
});

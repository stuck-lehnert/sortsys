import { expect, test } from "bun:test";
import { areaKey, bytes, createIdentity, encryptObject, InvalidProtectedData, record, VerifiedStore } from "../src";

test("a correctly signed invalid business value is quarantined, preserving the last valid version", async () => {
  const identity = await createIdentity();
  const key = await areaKey();
  const context = { tenant: "test", scope: "project:1", facet: "calculation" as const, object: "position:1", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };
  const decode = (value: unknown) => {
    const obj = record(value, ["priceCents"]);
    if (!Number.isSafeInteger(obj.priceCents) || (obj.priceCents as number) < 0) throw new InvalidProtectedData();
    return { priceCents: obj.priceCents as number };
  };
  const store = new VerifiedStore({ context, schema: { decode }, signer: async () => identity.signingKey.publicKey, key: async () => key });
  const first = await store.encrypt(context, { priceCents: 12345 }, key, identity.signingKey.privateKey);
  const read = await store.receive("position:1", first);
  expect(read).toEqual({ kind: "verified", current: { revision: "1", value: { priceCents: 12345 } } });
  const fork = await store.encrypt(context, { priceCents: 999 }, key, identity.signingKey.privateKey);
  expect((await store.receive("position:1", fork)).kind).toBe("invalid");
  // A malicious authorized writer bypasses their own schema, then signs normally.
  const invalid = await encryptObject({ ...context, revision: "2" }, bytes(JSON.stringify({ priceCents: "NaN", arbitraryField: "never merge me" })), key, identity.signingKey.privateKey);
  expect(await store.receive("position:1", invalid)).toEqual({ kind: "invalid", rejectedRevision: "2", lastGood: { revision: "1", value: { priceCents: 12345 } } });
  await expect(store.encrypt({ ...context, revision: "3" }, { priceCents: -1 }, key, identity.signingKey.privateKey)).rejects.toThrow();
  const fixed = await store.encrypt({ ...context, revision: "3" }, { priceCents: 12345 }, key, identity.signingKey.privateKey);
  expect((await store.receive("position:1", fixed)).kind).toBe("verified");
  expect((await store.receive("position:1", first)).kind).toBe("invalid");
  store.lock();
  const rejected = await store.receive("position:1", invalid);
  expect(rejected.kind === "invalid" && rejected.lastGood).toBeUndefined();
});

test("locking during decryption prevents a late result from repopulating the plaintext cache", async () => {
  const identity = await createIdentity();
  const key = await areaKey();
  const context = { tenant: "test", scope: "project:1", facet: "scope" as const, object: "position:1", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };
  let release!: (key: CryptoKey) => void;
  const waiting = new Promise<CryptoKey>(resolve => { release = resolve; });
  const store = new VerifiedStore({ context, schema: { decode: (value: unknown) => value }, signer: async () => waiting, key: async () => key });
  const input = await store.encrypt(context, { text: "private" }, key, identity.signingKey.privateKey);
  const result = store.receive(context.object, input);
  store.lock(); release(identity.signingKey.publicKey);
  expect(await result).toEqual({ kind: "invalid", rejectedRevision: "1", lastGood: undefined });
});

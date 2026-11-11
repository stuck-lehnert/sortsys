import { afterEach, expect, test } from "bun:test";
import { base64, bytes, createAccountVault, createDomain, createIdentity, createTenantSetup, encryptObject, InvalidProtectedData, publicIdentity } from "@sortsys/zerotrust";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { protectedCollection } from "./protectedObjects";

afterEach(() => lockCryptoSession());
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const AREA = { domain: "items:master-data", scope: "items", facet: "master-data", prefix: "item:" };
async function fixture() {
  const identity = await createIdentity(), { setup, authorityKey } = await createTenantSetup("test", "user:1", identity, PHRASE, { scopes: [{ scope: AREA.scope, facet: AREA.facet }] });
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(exportKey, await createAccountVault(exportKey, "test", "owner", identity, { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
  const domain = await createDomain({ tenant: "test", id: AREA.domain, scope: AREA.scope, facet: AREA.facet, generation: "1", policyVersion: "1", authorityGeneration: "1",
    authorityKey: authorityKey.privateKey, recovery: { encryptionKey: setup.authority.recoveryEncryptionKey, signingKey: setup.authority.recoverySigningKey }, readers: [{ subject: "user:1", identity: await publicIdentity(identity) }] });
  const objects = await Promise.all(Array.from({ length: 48 }, (_, index) => encryptObject({ tenant: "test", scope: AREA.scope, facet: AREA.facet, object: `item:${String(index).padStart(3, "0")}`,
    revision: "1", generation: "1", policyVersion: "1", author: "user:1" }, bytes(JSON.stringify({ index })), domain.key, identity.signingKey.privateKey)));
  const invalidJson = await encryptObject({ tenant: "test", scope: AREA.scope, facet: AREA.facet, object: "item:007", revision: "1", generation: "1", policyVersion: "1", author: "user:1" },
    bytes('Spezialkalkulationspreis 987654.321 ist kein JSON'), domain.key, identity.signingKey.privateKey);
  const state = { keyRequests: 0, definitionRequests: 0, failKey: false, reverse: false, corrupt: false, invalidJson: false, conflict: false, head: "1", beforeKey: async () => {}, transformPage: page => page, pages: [] };
  const client = { async query(path, input) {
    if (path === "auth.sessionInfo") return [{ user: { id: "1", username: "owner" }, roles: [] }, null];
    if (path === "zerotrust.trust.history") return [{ authorities: [{ certificate: setup.authority, transition: null }], identities: [setup.owner] }, null];
    if (path === "zerotrust.policy.get") return [setup.policy, null];
    if (path === "zerotrust.domains.list") return [[{ id: AREA.domain, scope: AREA.scope, facet: AREA.facet, generation: "1", rotationRequired: false }], null];
    if (path === "zerotrust.domains.get") { state.definitionRequests++; return [domain.definition, null]; }
    if (path === "zerotrust.keys.get") {
      state.keyRequests++; await state.beforeKey();
      return state.failKey ? [null, new Error("Key request failed")] : [domain.definition.envelopes[0], null];
    }
    if (path === "zerotrust.objects.list") {
      state.pages.push(input.snapshot);
      if (state.conflict && input.after) { state.conflict = false; state.head = "2"; return [null, new Error("Protected data changed; reload the current version")]; }
      let page = objects.filter(object => input.after === null || object.object > input.after).slice(0, 32);
      if (state.corrupt) page = page.map((object, index) => index === 7 ? { ...object, signature: (object.signature[0] === "A" ? "B" : "A") + object.signature.slice(1) } : object);
      if (state.invalidJson) page = page.map(object => object.object === invalidJson.object ? invalidJson : object);
      if (state.reverse) page = page.slice().reverse();
      return [state.transformPage({ snapshot: state.head, keyGeneration: "1", objects: page, after: input.after === null ? page.at(-1).object : null }), null];
    }
    throw new Error("Unexpected protected read " + path);
  }, async invalidate() {} };
  return { state, collection: await protectedCollection(client, AREA, new AbortController().signal) };
}

test("parallel object decryption preserves order and shares one verified key request across pages", async () => {
  const { state, collection } = await fixture();
  try {
    const objects = await collection.read();
    expect(objects.map(object => object.value.index)).toEqual(Array.from({ length: 48 }, (_, index) => index));
    expect(state.keyRequests).toBe(1); expect(state.definitionRequests).toBe(1); expect(state.pages).toEqual([null, "1"]);
  } finally { collection.close(); }
});

test("corrupt or unordered pages cannot supply a verified snapshot", async () => {
  for (const issue of ["corrupt", "reverse"]) {
    const { state, collection } = await fixture(); state[issue] = true;
    try {
      await expect(collection.read()).rejects.toThrow(); expect(() => collection.snapshot()).toThrow();
      if (issue === "reverse") expect(state.keyRequests).toBe(0);
      state[issue] = false;
      expect((await collection.read()).length).toBe(48); expect(collection.snapshot()).toBe("1");
    } finally { collection.close(); }
  }
});

test("a shared failed key request is retryable and a closed collection rejects late key replies", async () => {
  const first = await fixture(); first.state.failKey = true;
  try {
    await expect(first.collection.read()).rejects.toThrow("Key request failed"); expect(first.state.keyRequests).toBe(1);
    first.state.failKey = false;
    expect((await first.collection.read()).length).toBe(48); expect(first.state.keyRequests).toBe(2);
  } finally { first.collection.close(); }
  const next = await fixture(); let release;
  next.state.beforeKey = () => new Promise(done => { release = done; });
  const reading = next.collection.read();
  while (!release) await Bun.sleep(1);
  next.collection.close(); release();
  await expect(reading).rejects.toThrow(); expect(() => next.collection.snapshot()).toThrow();
});

test("a changed page snapshot discards the old attempt before publishing the replacement", async () => {
  const { state, collection } = await fixture(); state.conflict = true;
  try {
    expect((await collection.read()).map(object => object.value.index)).toEqual(Array.from({ length: 48 }, (_, index) => index));
    expect(state.pages).toEqual([null, "1", null, "2"]); expect(collection.snapshot()).toBe("2"); expect(state.keyRequests).toBe(1);
  } finally { collection.close(); }
});

test("a correctly signed but malformed private payload cannot quote plaintext in an error", async () => {
  const { state, collection } = await fixture(); state.invalidJson = true;
  try {
    let failure; try { await collection.read(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(InvalidProtectedData); expect(failure.message).not.toContain("Spezialkalkulationspreis");
    expect(failure.message).not.toContain("987654"); expect(() => collection.snapshot()).toThrow();
  } finally { collection.close(); }
});

test("malformed or oversized pages are rejected before requesting decryption keys", async () => {
  const { state, collection } = await fixture();
  try {
    for (const transform of [
      page => ({ ...page, objects: null }),
      page => ({ ...page, objects: { length: 1 } }),
      page => ({ ...page, objects: [...page.objects, page.objects[0]] }),
      page => ({ ...page, snapshot: 1 }),
      page => ({ ...page, after: false }),
      page => ({ ...page, objects: [{ ...page.objects[0], ciphertext: "A".repeat(48 * 1024 * 1024 + 1) }], after: null }),
    ]) {
      state.transformPage = transform;
      await expect(collection.read()).rejects.toBeInstanceOf(InvalidProtectedData);
      expect(state.keyRequests).toBe(0); expect(() => collection.snapshot()).toThrow();
    }
    state.transformPage = page => page;
    expect((await collection.read()).length).toBe(48); expect(collection.snapshot()).toBe("1");
  } finally { collection.close(); }
});

import { expect, test } from "bun:test";
import {
  areaKey,
  bytes,
  createIdentity,
  createZeroTrust,
  type EncryptedObject,
  VerifiedStore,
} from "../src/index";

async function fixture() {
  const security = createZeroTrust({ facets: ["research-notes"] });
  const identity = await createIdentity();
  const key = await areaKey();
  const context = {
    tenant: "laboratory:alpha",
    scope: "experiment:42",
    facet: "research-notes" as const,
    object: "note:1",
    revision: "1",
    generation: "1",
    policyVersion: "1",
    author: "researcher:lee",
  };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let delayed: string | undefined;
  const store = new VerifiedStore({
    objects: security.objects,
    context,
    schema: { decode: (value: unknown) => value },
    key: async () => key,
    async signer(envelope) {
      if (envelope.signature === delayed) await waiting;
      return identity.signingKey.publicKey;
    },
  });
  function write(revision: string, text: string) {
    return security.objects.encryptObject(
      { ...context, revision }, bytes(JSON.stringify({ text })), key, identity.signingKey.privateKey,
    );
  }
  function remove(revision: string) {
    return security.objects.encryptTombstone({ ...context, revision }, key, identity.signingKey.privateKey);
  }
  function delay(envelope: EncryptedObject) {
    delayed = envelope.signature;
    return store.receive(context.object, envelope);
  }
  return { store, context, write, remove, delay, release };
}

test("a delayed older revision cannot replace a newer verified value", async () => {
  const f = await fixture();
  const older = await f.write("1", "Earlier observation");
  const newer = await f.write("2", "Later observation");
  const waiting = f.delay(older);
  expect((await f.store.receive(f.context.object, newer)).kind).toBe("verified");
  f.release();
  expect(await waiting).toEqual({
    kind: "invalid",
    rejectedRevision: "1",
    lastGood: { revision: "2", value: { text: "Later observation" } },
  });
});

test("a delayed conflicting signature cannot replace the accepted revision", async () => {
  const f = await fixture();
  const first = await f.write("1", "First result");
  const fork = await f.write("1", "Conflicting result");
  const waiting = f.delay(fork);
  expect((await f.store.receive(f.context.object, first)).kind).toBe("verified");
  f.release();
  expect(await waiting).toEqual({
    kind: "invalid",
    rejectedRevision: "1",
    lastGood: { revision: "1", value: { text: "First result" } },
  });
});

test("a verified deletion rejects even a newer revision already being decrypted", async () => {
  const f = await fixture();
  const first = await f.write("1", "Original result");
  expect((await f.store.receive(f.context.object, first)).kind).toBe("verified");
  const lateUpdate = await f.write("3", "Cannot resurrect");
  const waiting = f.delay(lateUpdate);
  const removed = await f.remove("2");
  expect(await f.store.receive(f.context.object, removed)).toEqual({ kind: "deleted", revision: "2" });
  f.release();
  expect(await waiting).toEqual({ kind: "invalid", rejectedRevision: "3", lastGood: undefined });
  expect(await f.store.receive(f.context.object, removed)).toEqual({ kind: "deleted", revision: "2" });
});

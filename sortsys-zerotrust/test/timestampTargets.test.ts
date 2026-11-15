import { expect, test } from "bun:test";
import { areaKey, base64, bytes, createIdentity, digest, documentObject, documentTimestampTarget, encryptObject, encryptTombstone, objectFrame, objectTimestampTarget, signDocumentHead, signedPacketFrame, timestampTarget } from "../src/sortsys";
async function fixture() {
  const identity = await createIdentity(), key = await areaKey(), context = { tenant: "test", scope: "absence:2", facet: "master-data" as const,
    object: "absence:2:request:3", revision: "1", generation: "1", policyVersion: "1", author: "user:1" };
  const envelope = await encryptObject(context, bytes('{"reason":"Private Schulung"}'), key, identity.signingKey.privateKey);
  return { identity, key, context, envelope };
}
test("an immutable absence target commits to the complete signed ciphertext rather than its plaintext", async () => {
  const f = await fixture(), target = await objectTimestampTarget(f.envelope, f.identity.signingKey.publicKey);
  expect(target).toMatchObject({ kind: "absence-request", tenant: "test", scope: "absence:2", object: "absence:2:request:3", revision: "1" });
  expect(target!.digest).toBe(await digest(signedPacketFrame(objectFrame(f.envelope), f.envelope.signature)));
  expect(JSON.stringify(target)).not.toContain("Private Schulung");
  expect(Object.hasOwn(target!, "ots")).toBe(false);
  await expect(objectTimestampTarget({ ...f.envelope, ots: null }, f.identity.signingKey.publicKey)).rejects.toThrow();
});
test("a changed or foreign-signed envelope cannot reuse its target, and an ordinary revision cannot bypass immutability", async () => {
  const f = await fixture(), other = await createIdentity();
  await expect(objectTimestampTarget(f.envelope, other.signingKey.publicKey)).rejects.toThrow();
  await expect(objectTimestampTarget({ ...f.envelope, policyVersion: "2" }, f.identity.signingKey.publicKey)).rejects.toThrow();
  const changed = await encryptObject({ ...f.context, revision: "2" }, bytes("{}"), f.key, f.identity.signingKey.privateKey);
  await expect(objectTimestampTarget(changed, f.identity.signingKey.publicKey)).rejects.toThrow();
  const ordinary = await encryptObject({ ...f.context, scope: "other", object: "other:3" }, bytes("{}"), f.key, f.identity.signingKey.privateKey);
  expect(await objectTimestampTarget(ordinary, f.identity.signingKey.publicKey)).toBeNull();
});
test("withdrawal gets a separate target and never replaces the timestamped application", async () => {
  const f = await fixture(), original = await objectTimestampTarget(f.envelope, f.identity.signingKey.publicKey);
  const withdrawal = await encryptTombstone({ ...f.context, revision: "2" }, f.key, f.identity.signingKey.privateKey);
  const next = await objectTimestampTarget(withdrawal, f.identity.signingKey.publicKey);
  expect(next!.kind).toBe("absence-withdrawal"); expect(next!.object).toBe(original!.object); expect(next!.digest).not.toBe(original!.digest);
  const decision = await encryptObject({ ...f.context, facet: "personnel", object: "absence:2:decision:3" }, bytes("{}"), f.key, f.identity.signingKey.privateKey);
  expect((await objectTimestampTarget(decision, f.identity.signingKey.publicKey))!.kind).toBe("absence-decision");
});
test("only permanently locked document heads become finalization targets, without freezing received read-only versions", async () => {
  const f = await fixture(), input = { tenant: "test", scope: "commercial:2", id: "3", version: "1", previous: "", generation: "1", policyVersion: "1", author: "user:1",
    modifiedMicros: "1794484800000000", readOnly: true, locked: false, parts: [{ facet: "scope" as const, object: documentObject("commercial:2", "3", "scope", "0".repeat(32), "manifest"), hash: base64(new Uint8Array(32)), keys: [{ facet: "scope" as const, generation: "1" }] }] };
  expect(await documentTimestampTarget(await signDocumentHead(input, f.identity.signingKey.privateKey), f.identity.signingKey.publicKey)).toBeNull();
  const head = await signDocumentHead({ ...input, locked: true }, f.identity.signingKey.privateKey), target = await documentTimestampTarget(head, f.identity.signingKey.publicKey);
  expect(target).toMatchObject({ kind: "document", scope: "commercial:2", object: "3", revision: "1" });
  await expect(documentTimestampTarget({ ...head, parts: head.parts.map(part => ({ ...part, hash: base64(new Uint8Array(32).fill(1)) })) }, f.identity.signingKey.publicKey)).rejects.toThrow();
  expect(timestampTarget(target)).toEqual(target!);
  for (const change of [{ revision: "0" }, { kind: "other" }, { signature: "" }, { digest: "" }, { ots: null }]) expect(() => timestampTarget({ ...target, ...change })).toThrow();
});

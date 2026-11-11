import { expect, test } from "bun:test";
import { documentMicros, documentTimestamp, documentBlob, documentHead, documentHeadFrame, documentHeadHash, documentObject, signDocumentHead, verifyDocumentHead } from "./documents";
import { base64, bytes, digest, signedPacketFrame } from "./encoding";
import { signingPair } from "./identity";

test("signed document vectors bind independent facet epochs, revision ancestry and immutable manifests", async () => {
  const key = await signingPair(new Uint8Array(32).fill(23)), scope = "commercial:123", id = "456", token = "a".repeat(32);
  const head = await signDocumentHead({ tenant: "tenant-test", scope, id, version: "7", previous: "", generation: "2", policyVersion: "3", author: "user:12",
    modifiedMicros: documentMicros("2026-11-10T11:12:13.123456Z"), readOnly: false, locked: false,
    parts: [{ facet: "scope", object: documentObject(scope, id, "scope", token, "manifest"), hash: await digest(bytes("signed ciphertext")), keys: [{ facet: "scope", generation: "4" }] }],
  }, key.privateKey);
  expect(await verifyDocumentHead(head, { tenant: head.tenant, scope, id }, key.publicKey)).toEqual(head);
  expect(await documentHeadHash(head)).toBe(await digest(signedPacketFrame(await documentHeadFrame(head), head.signature)));
  for (const change of [{ version: "8" }, { modifiedMicros: documentMicros("2026-11-10T11:12:14Z") }, { locked: true }, { readOnly: true }, { scope: "commercial:124" }, { author: "user:13" },
    { parts: [{ ...head.parts[0]!, keys: [{ facet: "scope", generation: "5" }] }] }])
    await expect(verifyDocumentHead({ ...head, ...change }, { tenant: head.tenant, scope, id }, key.publicKey)).rejects.toThrow();
  expect(documentTimestamp(head.modifiedMicros)).toBe("2026-11-10T11:12:13.123456Z");
  expect(documentMicros("2026-11-10T12:12:13.123456+01:00")).toBe(head.modifiedMicros);
  expect(documentBlob(head.parts[0]!.object)).toEqual({ scope, id, facet: "scope", token, suffix: "manifest" });
  for (const object of ["commercial:123:opaque:document:456:" + token + ":manifest", "commercial:0123:scope:document:456:" + token + ":0"]) {
    let accepted = false; try { accepted = !!documentBlob(object); } catch { /* invalid binding */ } expect(accepted).toBe(false);
  }
  expect(() => documentHead({ ...head, plaintext: "forbidden" })).toThrow();
  expect(() => documentHead({ ...head, parts: [...head.parts, ...head.parts] })).toThrow();
  expect(() => documentHead({ ...head, parts: [{ ...head.parts[0]!, facet: "opaque" }] })).toThrow();
  expect(base64(await crypto.subtle.exportKey("raw", key.publicKey))).toHaveLength(43);
});

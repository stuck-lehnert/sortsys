import { expect, test } from "bun:test";
import { boxFrame, openBox, sealBox } from "../src/boxes";
import { areaKey, createIdentity, sign } from "../src/identity";
import {
  base64,
  bytes,
  InvalidProtectedData,
  randomSecret,
  sized,
  unbase64,
} from "../src/encoding";
import { objectSharingFixture } from "./support/objectShares";
import { objectKeyRecipientBinding } from "../src/core/objectShares";
import {
  signResourceAccess,
  verifyResourceAccess,
} from "../src/core/resourceAccess";

test("a recipient opens the exact original ciphertext without receiving its area's wrapping key", async () => {
  const f = await objectSharingFixture();
  expect(await f.security.objects.decryptSharedObject(f.open)).toEqual(
    f.plaintext,
  );
  expect(
    await f.security.objects.decryptObject(
      f.object,
      f.expected,
      f.wrappingKey,
      f.writer.signingKey.publicKey,
    ),
  ).toEqual(f.plaintext);
  expect(f.envelope.purpose).toBe("object-key");
  expect(f.envelope.generation).toBe("3");
  expect(f.object.generation).toBe("7");
  expect(f.envelope.author).not.toBe(f.object.author);
  await expect(
    f.security.objects.decryptObject(
      f.object,
      f.expected,
      f.recipient.encryptionKey.privateKey,
      f.writer.signingKey.publicKey,
    ),
  ).rejects.toThrow(InvalidProtectedData);
});

test("another object or later revision in the same area requires an independently issued key envelope", async () => {
  const f = await objectSharingFixture();
  for (const expected of [
    { ...f.expected, object: "appointment:18" },
    { ...f.expected, revision: "5" },
  ]) {
    const object = await f.security.objects.encryptObject(
      expected,
      bytes("Anderer privater Termin 582139"),
      f.wrappingKey,
      f.writer.signingKey.privateKey,
    );
    await expect(
      f.security.objects.decryptSharedObject({ ...f.open, object, expected }),
    ).rejects.toThrow(InvalidProtectedData);
    const envelope = await f.security.objects.shareObjectKey({
      ...f.issue,
      object,
      expected,
    });
    expect(
      await f.security.objects.decryptSharedObject({
        ...f.open,
        object,
        expected,
        envelope,
      }),
    ).toEqual(bytes("Anderer privater Termin 582139"));
  }
});

test("an adversarial recipient cannot bypass the helper and use the recovered record key on another ciphertext", async () => {
  const f = await objectSharingFixture();
  const context = await f.security.objects.objectKeyShareContext(
    f.object,
    f.share,
  );
  const raw = await openBox(
    f.envelope,
    context,
    f.recipient.encryptionKey.privateKey,
    f.manager.signingKey.publicKey,
  );
  try {
    const decryptionKey = await crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      raw,
      "AES-KW",
      false,
      ["unwrapKey"],
    );
    for (const expected of [
      { ...f.expected, object: "appointment:18" },
      { ...f.expected, revision: "5" },
    ]) {
      const object = await f.security.objects.encryptObject(
        expected,
        bytes("Another private appointment"),
        f.wrappingKey,
        f.writer.signingKey.privateKey,
      );
      await expect(
        crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: sized(object.nonce, 12),
            additionalData: f.security.objects.contextFrame(expected),
            tagLength: 128,
          },
          decryptionKey,
          unbase64(object.ciphertext),
        ),
      ).rejects.toThrow();
      await expect(
        crypto.subtle.unwrapKey(
          "raw",
          sized(object.wrappedKey, 40),
          wrappingKey,
          "AES-KW",
          "AES-GCM",
          false,
          ["decrypt"],
        ),
      ).rejects.toThrow();
    }
  } finally {
    raw.fill(0);
  }
});

test("sharing and opening authenticate the source and its complete expected context", async () => {
  const f = await objectSharingFixture();
  for (const expected of [
    { ...f.expected, tenant: "practice:other" },
    { ...f.expected, scope: "calendar:other" },
    { ...f.expected, facet: "research-notes" as const },
    { ...f.expected, object: "appointment:other" },
    { ...f.expected, revision: "5" },
    { ...f.expected, generation: "8" },
    { ...f.expected, policyVersion: "13" },
    { ...f.expected, author: "doctor:other" },
  ]) {
    await expect(
      f.security.objects.shareObjectKey({ ...f.issue, expected }),
    ).rejects.toThrow(InvalidProtectedData);
    await expect(
      f.security.objects.decryptSharedObject({ ...f.open, expected }),
    ).rejects.toThrow(InvalidProtectedData);
  }
  await expect(
    f.security.objects.shareObjectKey({
      ...f.issue,
      objectSigner: f.manager.signingKey.publicKey,
    }),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    f.security.objects.shareObjectKey({
      ...f.issue,
      wrappingKey: await areaKey(randomSecret()),
    }),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    f.security.objects.decryptSharedObject({
      ...f.open,
      objectSigner: f.manager.signingKey.publicKey,
    }),
  ).rejects.toThrow(InvalidProtectedData);
});

test("recipient, issuer and authority epoch are independently binding", async () => {
  const f = await objectSharingFixture();
  for (const share of [
    { ...f.share, authorityGeneration: "4" },
    { ...f.share, recipient: "patient:other" },
    { ...f.share, author: "doctor:other" },
  ]) {
    await expect(
      f.security.objects.decryptSharedObject({ ...f.open, share }),
    ).rejects.toThrow(InvalidProtectedData);
  }
  const other = await createIdentity();
  await expect(
    f.security.objects.decryptSharedObject({
      ...f.open,
      recipientKey: other.encryptionKey.privateKey,
    }),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    f.security.objects.decryptSharedObject({
      ...f.open,
      grantSigner: other.signingKey.publicKey,
    }),
  ).rejects.toThrow(InvalidProtectedData);
});

test("tampered key envelopes and correctly signed envelopes containing another key cannot open a record", async () => {
  const f = await objectSharingFixture();
  for (const change of [
    { tenant: "practice:other" },
    { purpose: "area-key" },
    { object: "object-key:other" },
    { recipient: "patient:other" },
    { author: "doctor:other" },
    { generation: "4" },
    { enc: base64(new Uint8Array(32)) },
    { ciphertext: base64(new Uint8Array(48)) },
    { signature: base64(new Uint8Array(64)) },
  ]) {
    await expect(
      f.security.objects.decryptSharedObject({
        ...f.open,
        envelope: { ...f.envelope, ...change },
      }),
    ).rejects.toThrow(InvalidProtectedData);
  }
  const context = await f.security.objects.objectKeyShareContext(
    f.object,
    f.share,
  );
  for (const key of [new Uint8Array(16), randomSecret()]) {
    const envelope = await sealBox(
      context,
      key,
      f.recipient.encryptionKey.publicKey,
      f.manager.signingKey.privateKey,
    );
    await expect(
      f.security.objects.decryptSharedObject({ ...f.open, envelope }),
    ).rejects.toThrow(InvalidProtectedData);
  }
  const rebound = { ...f.envelope, recipient: "patient:other", signature: "" };
  rebound.signature = await sign(
    f.manager.signingKey.privateKey,
    boxFrame(rebound),
  );
  await expect(
    f.security.objects.decryptSharedObject({
      ...f.open,
      envelope: rebound,
      share: { ...f.share, recipient: "patient:other" },
    }),
  ).rejects.toThrow(InvalidProtectedData);
});

test("tombstones cannot create or consume an object read grant", async () => {
  const f = await objectSharingFixture();
  const expected = { ...f.expected, revision: "5" };
  const object = await f.security.objects.encryptTombstone(
    expected,
    f.wrappingKey,
    f.writer.signingKey.privateKey,
  );
  await expect(
    f.security.objects.shareObjectKey({ ...f.issue, object, expected }),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    f.security.objects.decryptSharedObject({ ...f.open, object, expected }),
  ).rejects.toThrow(InvalidProtectedData);
});

test("the signed access state rejects stripping or substituting the recipient envelope", async () => {
  const f = await objectSharingFixture();
  const binding = await objectKeyRecipientBinding(
    f.certifiedRecipient,
    f.envelope,
  );
  const state = await signResourceAccess(
    {
      tenant: f.object.tenant,
      resource: f.object.scope,
      object: f.object.object,
      revision: f.object.revision,
      generation: f.share.authorityGeneration,
      binding,
      active: true,
      packetSignature: f.object.signature,
      author: f.certifiedIssuer,
    },
    f.manager.signingKey.privateKey,
  );
  const expected = {
    tenant: state.tenant,
    resource: state.resource,
    object: state.object,
    generation: state.generation,
    binding,
  };
  expect(
    (
      await verifyResourceAccess(
        state,
        expected,
        () => f.authority.signingKey.publicKey,
      )
    ).active,
  ).toBe(true);
  const empty = await objectKeyRecipientBinding(null, null);
  expect(empty).not.toBe(binding);
  await expect(
    verifyResourceAccess(
      state,
      { ...expected, binding: empty },
      () => f.authority.signingKey.publicKey,
    ),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(objectKeyRecipientBinding(null, f.envelope)).rejects.toThrow(
    InvalidProtectedData,
  );
  await expect(
    objectKeyRecipientBinding(f.certifiedRecipient, null),
  ).rejects.toThrow(InvalidProtectedData);
  const changed = await objectKeyRecipientBinding(f.certifiedRecipient, {
    ...f.envelope,
    signature: base64(new Uint8Array(64)),
  });
  await expect(
    verifyResourceAccess(
      state,
      { ...expected, binding: changed },
      () => f.authority.signingKey.publicKey,
    ),
  ).rejects.toThrow(InvalidProtectedData);
});

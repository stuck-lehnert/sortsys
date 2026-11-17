import { expect, test } from "bun:test";
import {
  base64,
  certifyIdentity,
  identityCertificateHeads,
  identityCertificateFrame,
  InvalidProtectedData,
  objectFrame,
  publicSigningKey,
  randomSecret,
  verifyTrustHistory,
} from "../src/sortsys";
import { identitySuccessionFixture } from "./support/identitySuccessionFixture";

test("a complete unordered succession selects the current key and keeps historical signatures verifiable", async () => {
  const f = await identitySuccessionFixture();
  const history = await verifyTrustHistory(f.history, f.pinned);
  expect(history.identityCertificate(f.initial.user)).toEqual(f.latest);
  expect(await publicSigningKey(await history.signer(f.oldObject))).toBe(
    f.initial.signingKey,
  );
  expect(await publicSigningKey(await history.signer(f.newObject))).toBe(
    f.latest.signingKey,
  );
  expect(
    await publicSigningKey(
      await history.proofSigner(
        f.initial.user,
        "1",
        f.oldObject.signature,
        objectFrame(f.oldObject),
      ),
    ),
  ).toBe(f.initial.signingKey);
  await history.verifyIdentityProof(
    f.initial.user,
    "1",
    f.newObject.signature,
    objectFrame(f.newObject),
  );
  await expect(
    history.proofSigner(
      f.initial.user,
      "2",
      f.oldObject.signature,
      objectFrame(f.oldObject),
    ),
  ).rejects.toThrow();
  await expect(
    history.proofSigner(
      "account:outsider",
      "1",
      f.oldObject.signature,
      objectFrame(f.oldObject),
    ),
  ).rejects.toThrow();
  await expect(
    history.proofSigner(
      f.initial.user,
      "1",
      f.oldObject.signature,
      objectFrame(f.newObject),
    ),
  ).rejects.toThrow();
  const publicHead = history.identityCertificate(f.initial.user);
  publicHead.signingKey = base64(randomSecret());
  expect(history.identityCertificate(f.initial.user)).toEqual(f.latest);
});

test("forks, missing predecessors, duplicate certificates and unrelated initial keys never choose an arbitrary head", async () => {
  const f = await identitySuccessionFixture();
  const fork = await certifyIdentity(
    {
      tenant: f.next.tenant,
      generation: f.next.generation,
      user: f.next.user,
      encryptionKey: f.latest.encryptionKey,
      signingKey: f.latest.signingKey,
      previousSignature: f.initial.signature,
    },
    f.authorityKey.privateKey,
  );
  const unrelated = await certifyIdentity(
    {
      tenant: f.initial.tenant,
      generation: f.initial.generation,
      user: f.initial.user,
      encryptionKey: f.latest.encryptionKey,
      signingKey: f.latest.signingKey,
    },
    f.authorityKey.privateKey,
  );
  for (const identities of [
    [f.initial, f.next, fork],
    [f.latest, f.initial],
    [f.initial, f.initial],
    [f.initial, unrelated],
    [f.latest],
    [f.initial, { ...f.next, user: "account:other" }],
    [f.initial, { ...f.next, generation: "2" }],
  ]) {
    await expect(
      verifyTrustHistory({ ...f.history, identities }, f.pinned),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
  }
});

test("the authority signature binds the exact predecessor and strict decoders reject extra or malformed fields", async () => {
  const f = await identitySuccessionFixture();
  for (const next of [
    { ...f.next, previousSignature: f.latest.signature },
    { ...f.next, previousSignature: "short" },
    { ...f.next, unexpected: true },
  ])
    await expect(
      verifyTrustHistory(
        { ...f.history, identities: [f.initial, next] },
        f.pinned,
      ),
    ).rejects.toThrow();
  const stripped = { ...f.next };
  delete stripped.previousSignature;
  await expect(
    verifyTrustHistory({ ...f.history, identities: [stripped] }, f.pinned),
  ).rejects.toThrow();
  expect(identityCertificateFrame(f.initial)).not.toEqual(
    identityCertificateFrame(f.next),
  );
});

test("the chain decoder rejects a detached cycle rather than following unbounded links", async () => {
  const f = await identitySuccessionFixture();
  expect(() =>
    identityCertificateHeads([
      f.initial,
      { ...f.next, previousSignature: f.latest.signature },
      f.latest,
    ]),
  ).toThrow(InvalidProtectedData);
});

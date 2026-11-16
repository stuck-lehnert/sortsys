import { expect, test } from "bun:test";
import {
  base64,
  bytes,
  certifyIdentity,
  createIdentity,
  createOrigin,
  creationAssignmentBinding,
  creationRules,
  encryptObject,
  publicIdentity,
  signResourceAccess,
  verifyCreationOrigin,
  verifyResourceAccess,
  createDelegatedDomain,
  openBox,
  areaKey,
  decryptObject,
} from "../src/sortsys";
import { creationFixture } from "./support/creationFixture";

async function fixture() {
  const base = await creationFixture("tool-tracking");
  const recipient = await createIdentity();
  const assignee = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:3",
      ...(await publicIdentity(recipient)),
    },
    base.authorityKey.privateKey,
  );
  const origin = await createOrigin(
    { ...base.origin, assignee },
    base.creator.signingKey.privateKey,
  );
  const made = await createDelegatedDomain({
    origin,
    creatorKey: base.creator.signingKey.privateKey,
    policyVersion: "1",
    recovery: {
      encryptionKey: base.setup.authority.recoveryEncryptionKey,
      signingKey: base.setup.authority.recoverySigningKey,
    },
  });
  const context = {
    tenant: "test",
    scope: origin.scope,
    facet: "master-data" as const,
    object: `${origin.scope}:master-data:record`,
    revision: "1",
    generation: "1",
    policyVersion: "1",
    author: "user:2",
  };
  const object = await encryptObject(
    context,
    bytes("Private assigned booking"),
    made.key,
    base.creator.signingKey.privateKey,
  );
  const expected = {
    tenant: "test",
    resource: origin.scope,
    object: context.object,
    generation: "1",
    binding: await creationAssignmentBinding(origin),
  };
  const state = await signResourceAccess(
    {
      ...expected,
      revision: "1",
      active: true,
      packetSignature: object.signature,
      author: origin.capability.creator,
    },
    base.creator.signingKey.privateKey,
  );
  return {
    ...base,
    origin,
    recipient,
    assignee,
    made,
    object,
    context,
    expected,
    state,
  };
}

test("a resource state binds one exact ciphertext and its certified author", async () => {
  const f = await fixture();
  const verified = await verifyResourceAccess(
    f.state,
    f.expected,
    () => f.authorityKey.publicKey,
  );
  expect(verified).toEqual(f.state);
  expect(verified).not.toBe(f.state);
  for (const changed of [
    { ...f.state, active: false },
    { ...f.state, packetSignature: base64(new Uint8Array(64)) },
    { ...f.state, revision: "2" },
    { ...f.state, author: f.assignee },
    { ...f.state, binding: base64(new Uint8Array(32)) },
  ])
    await expect(
      verifyResourceAccess(changed, f.expected, () => f.authorityKey.publicKey),
    ).rejects.toThrow();
  for (const expected of [
    { ...f.expected, tenant: "another" },
    { ...f.expected, resource: "tool-tracking:def" },
    { ...f.expected, object: "tool-tracking:abc:scope:record" },
    { ...f.expected, generation: "2" },
  ])
    await expect(
      verifyResourceAccess(f.state, expected, () => f.authorityKey.publicKey),
    ).rejects.toThrow();
});

test("an assignee receives read access only through an authenticated active state", async () => {
  const f = await fixture();
  expect(
    creationRules(f.origin).some((rule) => rule.subject === "user:3"),
  ).toBe(false);
  const active = await verifyCreationOrigin(
    { ...f.origin, access: f.state },
    () => f.authorityKey.publicKey,
  );
  expect(
    creationRules(active).filter((rule) => rule.subject === "user:3"),
  ).toEqual([
    {
      subject: "user:3",
      scope: f.origin.scope,
      facet: "master-data",
      effect: "allow",
      actions: ["read"],
    },
  ]);
  const closed = await signResourceAccess(
    { ...f.state, active: false, revision: "2" },
    f.creator.signingKey.privateKey,
  );
  const ended = await verifyCreationOrigin(
    { ...f.origin, access: closed },
    () => f.authorityKey.publicKey,
  );
  expect(creationRules(ended).some((rule) => rule.subject === "user:3")).toBe(
    false,
  );
  const { access, ...removed } = ended;
  expect(creationRules(removed).some((rule) => rule.subject === "user:3")).toBe(
    false,
  );
  await expect(
    verifyCreationOrigin(
      { ...f.origin, access: { ...closed, active: true } },
      () => f.authorityKey.publicKey,
    ),
  ).rejects.toThrow();
});

test("an assignee can open the independently wrapped booking key", async () => {
  const f = await fixture();
  const box = f.made.definition.envelopes.find(
    (box) => box.recipient === "user:3",
  )!;
  const raw = await openBox(
    box,
    {
      tenant: "test",
      purpose: "area-key",
      object: f.origin.id,
      generation: "1",
      recipient: "user:3",
      author: box.author,
    },
    f.recipient.encryptionKey.privateKey,
    f.creator.signingKey.publicKey,
  );
  try {
    expect(
      new TextDecoder().decode(
        await decryptObject(
          f.object,
          f.context,
          await areaKey(raw),
          f.creator.signingKey.publicKey,
        ),
      ),
    ).toBe("Private assigned booking");
  } finally {
    raw.fill(0);
  }
});

test("assignment proofs cannot grant prices or unrelated resource access", async () => {
  const f = await fixture();
  for (const changed of [
    {
      ...f.origin,
      facet: "procurement" as const,
      id: `${f.origin.scope}:procurement`,
    },
    { ...f.origin, assignee: { ...f.assignee, tenant: "another" } },
    { ...f.origin, assignee: { ...f.assignee, generation: "2" } },
    { ...f.origin, assignee: f.origin.capability.creator },
  ])
    await expect(
      createOrigin(changed, f.creator.signingKey.privateKey),
    ).rejects.toThrow();
  const other = await creationFixture("project");
  await expect(
    createOrigin(
      { ...other.origin, assignee: f.assignee },
      other.creator.signingKey.privateKey,
    ),
  ).rejects.toThrow();
});

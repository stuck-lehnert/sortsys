import { expect, test } from "bun:test";
import {
  base64,
  createIdentity,
  ownerRegistrationFrame,
  sign,
  verify,
} from "../src/index";
import type { OwnerRegistration } from "../src/index";
import {
  createRecoveryPhrase,
  createTenantSetup,
  verifyAuthority,
  signInitializationSource,
  verifyInitializationSource,
} from "../src/sortsys";

test("first-owner possession cannot be reused for another account, vault or initial root", async () => {
  const owner = await createIdentity();
  const binding: OwnerRegistration = {
    tenant: "contractor",
    subject: "user:owner",
    username: "office",
    exchangeHash: base64(new Uint8Array(32).fill(1)),
    registrationHash: base64(new Uint8Array(32).fill(2)),
    vaultHash: base64(new Uint8Array(32).fill(3)),
    setupHash: base64(new Uint8Array(32).fill(4)),
    locale: "de",
  };
  const proof = await sign(
    owner.signingKey.privateKey,
    ownerRegistrationFrame(binding),
  );
  await verify(
    owner.signingKey.publicKey,
    proof,
    ownerRegistrationFrame(binding),
  );
  const changedHash = base64(new Uint8Array(32).fill(5));
  const substitutions: Partial<OwnerRegistration>[] = [
    { tenant: "another-contractor" },
    { subject: "user:someone-else" },
    { username: "someone-else" },
    { exchangeHash: changedHash },
    { registrationHash: changedHash },
    { vaultHash: changedHash },
    { setupHash: changedHash },
    { locale: "en" },
  ];
  for (const substitution of substitutions) {
    await expect(
      verify(
        owner.signingKey.publicKey,
        proof,
        ownerRegistrationFrame({ ...binding, ...substitution }),
      ),
    ).rejects.toThrow();
  }
  expect(() =>
    ownerRegistrationFrame({ ...binding, vaultHash: "not-a-hash" }),
  ).toThrow();
  expect(() =>
    ownerRegistrationFrame({
      ...binding,
      password: "must-not-be-transmitted",
    } as OwnerRegistration),
  ).toThrow();
});

test("a signed setup context and its source receipts cannot be removed or transplanted", async () => {
  const context = `backup:${base64(new Uint8Array(32).fill(19))}`;
  const created = await createTenantSetup(
    "contractor",
    "user:17",
    await createIdentity(),
    createRecoveryPhrase(),
    { context },
  );
  const pinned = {
    tenant: "contractor",
    generation: "1",
    recoverySigningKey: created.setup.authority.recoverySigningKey,
  };
  expect((await verifyAuthority(created.setup.authority, pinned)).context).toBe(
    context,
  );
  const { context: omitted, ...withoutContext } = created.setup.authority;
  await expect(verifyAuthority(withoutContext, pinned)).rejects.toThrow();
  await expect(
    verifyAuthority(
      { ...created.setup.authority, context: "different" },
      pinned,
    ),
  ).rejects.toThrow();
  const source = await signInitializationSource(
    {
      tenant: "contractor",
      context,
      generation: "1",
      author: "user:17",
      manifest: `${context}:manifest`,
      objectSignature: base64(new Uint8Array(64).fill(3)),
    },
    created.authorityKey.privateKey,
  );
  const expected = {
    tenant: "contractor",
    context,
    authority: () => created.authorityKey.publicKey,
  };
  expect(await verifyInitializationSource(source, expected)).toEqual(source);
  const completion = await signInitializationSource(
    {
      tenant: source.tenant,
      context,
      generation: "1",
      author: source.author,
      manifest: `${context}:receipt`,
      objectSignature: base64(new Uint8Array(64).fill(4)),
      sourceSignature: source.signature,
    },
    created.authorityKey.privateKey,
  );
  expect(await verifyInitializationSource(completion, expected)).toEqual(
    completion,
  );
  const { sourceSignature, ...withoutSource } = completion;
  await expect(
    verifyInitializationSource(withoutSource, expected),
  ).rejects.toThrow();
  for (const change of [
    { manifest: `${context}:other` },
    { author: "user:18" },
    { objectSignature: base64(new Uint8Array(64).fill(5)) },
  ]) {
    await expect(
      verifyInitializationSource({ ...source, ...change }, expected),
    ).rejects.toThrow();
  }
});

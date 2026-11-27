import { expect, spyOn, test } from "bun:test";
import { bytes, digest, frame, InvalidProtectedData } from "../src/encoding";
import { certifyAuthority, certifyIdentity } from "../src/core/certificates";
import {
  createIdentity,
  importSigningKey,
  publicIdentity,
  sign,
  verify,
} from "../src/identity";
import {
  createPublicProofVerifier,
  publicProofDigest,
} from "../src/publicProofs";
import { verifyTrustHistory } from "../src/trustHistory";

test("warm trust history reuses public signature checks but reads the current identity set", async () => {
  const recovery = await createIdentity();
  const authority = await createIdentity();
  const recoveryKeys = await publicIdentity(recovery);
  const authorityKeys = await publicIdentity(authority);
  const pin = {
    tenant: "test-trust-history",
    generation: "1",
    recoverySigningKey: recoveryKeys.signingKey,
  };
  const certificate = await certifyAuthority(
    {
      ...pin,
      recoveryEncryptionKey: recoveryKeys.encryptionKey,
      authoritySigningKey: authorityKeys.signingKey,
    },
    recovery.signingKey.privateKey,
  );
  const identities = await Promise.all(
    Array.from({ length: 52 }, async (_, index) => {
      const identity = await publicIdentity(await createIdentity());
      return certifyIdentity(
        {
          ...identity,
          tenant: pin.tenant,
          generation: pin.generation,
          user: `user:${index + 1}`,
        },
        authority.signingKey.privateKey,
      );
    }),
  );
  const history = { authorities: [{ certificate, transition: null }], identities };

  const math = spyOn(crypto.subtle, "verify");
  try {
    const first = await verifyTrustHistory(history, pin);
    expect(first.identityCertificate("user:52")).toEqual(identities[51]!);
    expect(math).toHaveBeenCalledTimes(53);

    math.mockClear();
    const second = await verifyTrustHistory(structuredClone(history), pin);
    expect(second.identityCertificate("user:52")).toEqual(identities[51]!);
    expect(math).toHaveBeenCalledTimes(0);

    const fewerIdentities = { ...history, identities: identities.slice(0, -1) };
    const current = await verifyTrustHistory(fewerIdentities, pin);
    expect(() => current.identityCertificate("user:52")).toThrow(
      InvalidProtectedData,
    );
    expect(math).toHaveBeenCalledTimes(0);

    const substituted = structuredClone(history);
    substituted.identities[51]!.signingKey = identities[50]!.signingKey;
    await expect(verifyTrustHistory(substituted, pin)).rejects.toThrow(
      InvalidProtectedData,
    );
    expect(math).toHaveBeenCalledTimes(1);

    const original = identities[51]!;
    const successor = await certifyIdentity(
      {
        ...(await publicIdentity(await createIdentity())),
        tenant: original.tenant,
        generation: original.generation,
        user: original.user,
        previousSignature: original.signature,
      },
      authority.signingKey.privateKey,
    );
    const renewed = { ...history, identities: [successor, ...identities] };
    const withRenewal = await verifyTrustHistory(renewed, pin);
    expect(withRenewal.identityCertificate(original.user)).toEqual(successor);
    expect(withRenewal.signingKeys(original.user, original.generation))
      .toHaveLength(2);

    // A warm, valid signature does not make its predecessor optional.
    const missingOriginal = {
      ...fewerIdentities,
      identities: [successor, ...fewerIdentities.identities],
    };
    await expect(verifyTrustHistory(missingOriginal, pin)).rejects.toThrow(
      InvalidProtectedData,
    );
  } finally {
    math.mockRestore();
  }
});

test("public proof digests match WebCrypto for small, offset and large frames", async () => {
  const source = bytes("Prüfung mit Umlauten und einem Rand");
  const large = new Uint8Array(70_000);
  large.set(source, 1024);
  for (const value of [
    source,
    source.subarray(3, 17),
    new DataView(source.buffer, 2, 9),
    source.buffer,
    large,
  ])
    expect(await publicProofDigest(value)).toBe(await digest(value));
});

test("repeated public checks share verification but bind the exact key, signature and bytes", async () => {
  const first = await createIdentity();
  const second = await createIdentity();
  const message = frame("test/public-proof/v1", ["tenant-a", "notes", "1"]);
  const signature = await sign(first.signingKey.privateKey, message);
  const reader = createPublicProofVerifier();
  const math = spyOn(crypto.subtle, "verify");
  try {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        reader.verify(first.signingKey.publicKey, signature, message),
      ),
    );
    expect(math).toHaveBeenCalledTimes(1);
    const changed = message.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        reader.verify(first.signingKey.publicKey, signature, changed),
      ).rejects.toThrow(InvalidProtectedData);
    expect(math).toHaveBeenCalledTimes(3);
    await expect(
      reader.verify(second.signingKey.publicKey, signature, message),
    ).rejects.toThrow(InvalidProtectedData);
    await expect(
      reader.verify(first.signingKey.publicKey, "invalid", message),
    ).rejects.toThrow(InvalidProtectedData);
    expect(math).toHaveBeenCalledTimes(4);
    await reader.verify(first.signingKey.publicKey, signature, message);
    expect(math).toHaveBeenCalledTimes(4);
    reader.clear();
    await reader.verify(first.signingKey.publicKey, signature, message);
    expect(math).toHaveBeenCalledTimes(5);
  } finally {
    math.mockRestore();
  }
});

test("public verification remains bounded and ordinary verification never uses its cache", async () => {
  const identity = await createIdentity();
  const first = bytes("Öffentlicher Nachweis 1");
  const second = bytes("Öffentlicher Nachweis 2");
  const firstSignature = await sign(identity.signingKey.privateKey, first);
  const secondSignature = await sign(identity.signingKey.privateKey, second);
  const reader = createPublicProofVerifier({ capacity: 1 });
  const math = spyOn(crypto.subtle, "verify");
  try {
    await reader.verify(identity.signingKey.publicKey, firstSignature, first);
    await reader.verify(identity.signingKey.publicKey, secondSignature, second);
    await reader.verify(identity.signingKey.publicKey, firstSignature, first);
    expect(math).toHaveBeenCalledTimes(3);
    await verify(identity.signingKey.publicKey, firstSignature, first);
    expect(math).toHaveBeenCalledTimes(4);
  } finally {
    math.mockRestore();
  }
});

test("large public frames and disabled caches still perform every signature check", async () => {
  const identity = await createIdentity();
  const message = new Uint8Array(70_000);
  const signature = await sign(identity.signingKey.privateKey, message);
  const reader = createPublicProofVerifier();
  const disabled = createPublicProofVerifier({ capacity: 0 });
  const math = spyOn(crypto.subtle, "verify");
  try {
    await reader.verify(identity.signingKey.publicKey, signature, message);
    await reader.verify(identity.signingKey.publicKey, signature, message);
    await disabled.verify(identity.signingKey.publicKey, signature, message);
    expect(math).toHaveBeenCalledTimes(3);
  } finally {
    math.mockRestore();
  }
  for (const capacity of [-1, 1.5, 16385])
    expect(() => createPublicProofVerifier({ capacity })).toThrow(RangeError);
});

test("public signing-key imports retain only verification keys and canonical encodings", async () => {
  const identity = await createIdentity();
  const publicKeys = await publicIdentity(identity);
  const [first, second] = await Promise.all([
    importSigningKey(publicKeys.signingKey),
    importSigningKey(publicKeys.signingKey),
  ]);
  expect(first).toBe(second);
  expect(first.usages).toEqual(["verify"]);
  expect(first.type).toBe("public");
  await expect(importSigningKey(`${publicKeys.signingKey}=`)).rejects.toThrow(
    InvalidProtectedData,
  );
});

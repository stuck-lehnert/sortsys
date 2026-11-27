import { expect, spyOn, test } from "bun:test";
import {
  base64,
  createAccountVault,
  createIdentity,
  credentialIdentifier,
  credentialPrincipal,
  openAccountVault,
  publicIdentity,
  randomSecret,
} from "../src/index";
import { hpke, importSigningKey } from "../src/identity";

test("credential identities use framed tenant and immutable subject boundaries", () => {
  const first = { tenant: "practice/alpha", subject: "doctor:lee" };
  const second = { tenant: "practice", subject: "alpha/doctor:lee" };
  expect(credentialIdentifier(first)).not.toBe(credentialIdentifier(second));
  expect(credentialIdentifier(first)).toBe(credentialIdentifier({ ...first }));
  expect(() =>
    credentialPrincipal({ ...first, username: "mutable.alias" }),
  ).toThrow();
  expect(() =>
    credentialPrincipal({ tenant: "practice", subject: "" }),
  ).toThrow();
});

test("a vault binds the immutable account instead of a mutable login name", async () => {
  const identity = await createIdentity();
  const exportKey = base64(
    new Uint8Array([...randomSecret(), ...randomSecret()]),
  );
  const vault = await createAccountVault(
    exportKey,
    "practice",
    "doctor:lee",
    identity,
  );
  expect(Object.keys(vault)).not.toContain("username");
  const opened = await openAccountVault(
    exportKey,
    "practice",
    "doctor:lee",
    vault,
  );
  expect(await publicIdentity(opened.identity)).toEqual(
    await publicIdentity(identity),
  );
  await expect(
    openAccountVault(exportKey, "practice", "doctor:other", vault),
  ).rejects.toThrow();
  await expect(
    openAccountVault(exportKey, "practice", "doctor:other", {
      ...vault,
      subject: "doctor:other",
    }),
  ).rejects.toThrow();
  await expect(
    openAccountVault(exportKey, "other", "doctor:lee", {
      ...vault,
      tenant: "other",
    }),
  ).rejects.toThrow();
});

test("opening an account vault reuses imported keys without retaining private keys across opens", async () => {
  const identity = await createIdentity();
  const exportKey = base64(
    new Uint8Array([...randomSecret(), ...randomSecret()]),
  );
  const vault = await createAccountVault(
    exportKey,
    "practice",
    "doctor:lee",
    identity,
  );
  const verifier = await importSigningKey(vault.signingKey);

  const deserialize = spyOn(hpke.kem, "deserializePrivateKey");
  const importKey = spyOn(hpke.kem, "importKey");

  try {
    const unlock = () => openAccountVault(exportKey, "practice", "doctor:lee", vault);
    const first = (await unlock()).identity;
    const second = (await unlock()).identity;

    expect(deserialize).toHaveBeenCalledTimes(2);
    expect(importKey.mock.calls.filter(([, , isPublic]) => isPublic === false))
      .toHaveLength(0);
    expect(first.signingKey.publicKey).toBe(verifier);
    expect(second.signingKey.publicKey).toBe(verifier);
    expect(first.encryptionKey.privateKey).not.toBe(second.encryptionKey.privateKey);
    expect(first.signingKey.privateKey).not.toBe(second.signingKey.privateKey);
  } finally {
    deserialize.mockRestore();
    importKey.mockRestore();
  }
});

test("opening an authenticated vault rejects private keys that do not match its public identity", async () => {
  const [identity, other] = await Promise.all([
    createIdentity(),
    createIdentity(),
  ]);
  const exportKey = base64(
    new Uint8Array([...randomSecret(), ...randomSecret()]),
  );

  for (const key of ["encryptionKey", "signingKey"] as const) {
    const mismatched = {
      ...identity,
      [key]: {
        publicKey: identity[key].publicKey,
        privateKey: other[key].privateKey,
      },
    };
    const vault = await createAccountVault(
      exportKey,
      "practice",
      "doctor:lee",
      mismatched,
    );

    await expect(
      openAccountVault(exportKey, "practice", "doctor:lee", vault),
    ).rejects.toThrow();
  }
});

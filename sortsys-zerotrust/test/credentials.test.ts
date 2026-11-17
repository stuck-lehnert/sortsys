import { expect, test } from "bun:test";
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

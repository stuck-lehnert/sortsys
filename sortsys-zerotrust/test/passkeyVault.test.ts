import { expect, test } from "bun:test";
import {
  base64,
  createAccountVault,
  createIdentity,
  createPasskeyVault,
  openAccountVault,
  openAccountVaultWithKey,
  openPasskeyVault,
  passkeyPrfInput,
  PasskeyUnlock,
  publicIdentity,
  rewrapAccountVault,
  updateAccountVault,
} from "../src/sortsys";

test("an owned passkey result is not serializable and stops working after disposal", async () => {
  const value = await fixture();
  const unlock = PasskeyUnlock.consume(value.prf, value.expected);
  expect(value.prf.every((byte) => byte === 0)).toBe(true);
  expect(JSON.stringify({ unlock })).toBe("{}");
  const packet = await unlock.createVault(value.opened.dataKey, value.vault);
  const opened = await unlock.openVault(value.expected, packet, value.vault);
  expect(await publicIdentity(opened.identity)).toEqual(
    await publicIdentity(value.identity),
  );
  unlock.dispose();
  await expect(unlock.openVault(value.expected, packet, value.vault)).rejects
    .toThrow();
});

test("disposing a passkey result prevents an in-flight wrapper from being returned", async () => {
  const value = await fixture();
  const unlock = PasskeyUnlock.consume(value.prf, value.expected);
  const pending = unlock.createVault(value.opened.dataKey, value.vault);
  unlock.dispose();
  await expect(pending).rejects.toThrow();
});

async function fixture() {
  const identity = await createIdentity();
  const passwordKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  const vault = await createAccountVault(
    passwordKey,
    "test",
    "john.doe",
    identity,
    { recoveryGeneration: "1" },
  );
  const opened = await openAccountVault(passwordKey, "test", "john.doe", vault);
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const expected = {
    tenant: "test",
    subject: "john.doe",
    rpId: "example.test",
    credentialId: base64(crypto.getRandomValues(new Uint8Array(32))),
  };
  const binding = await createPasskeyVault(
    prf,
    opened.dataKey,
    vault,
    expected.rpId,
    expected.credentialId,
  );
  return { identity, passwordKey, vault, opened, prf, expected, binding };
}

test("a passkey opens the same identity without the password export key", async () => {
  const value = await fixture();
  const opened = await openPasskeyVault(
    value.prf,
    value.expected,
    value.binding,
    value.vault,
  );
  expect(await publicIdentity(opened.identity)).toEqual(
    await publicIdentity(value.identity),
  );
  expect(opened.pins).toEqual({ recoveryGeneration: "1" });
  const serialized = JSON.stringify(value.binding);
  expect(serialized).not.toContain(base64(value.prf));
  expect(serialized).not.toContain(value.passwordKey);
  expect(serialized).not.toContain(
    base64(await crypto.subtle.exportKey("raw", opened.dataKey)),
  );
});

test("a password change and pin updates retain passkey access without revealing the password", async () => {
  const value = await fixture();
  const nextPasswordKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  const changed = await createAccountVault(
    nextPasswordKey,
    "test",
    "john.doe",
    value.identity,
    { recoveryGeneration: "2" },
    value.opened.dataKey,
  );
  await expect(openAccountVault(value.passwordKey, "test", "john.doe", changed))
    .rejects.toThrow();
  const opened = await openPasskeyVault(
    value.prf,
    value.expected,
    value.binding,
    changed,
  );
  expect(opened.pins).toEqual({ recoveryGeneration: "2" });
  const next = await updateAccountVault(opened.dataKey, changed, {
    recoveryGeneration: "3",
  });
  expect(next.wrappedKey).toBe(changed.wrappedKey);
  expect(
    (await openAccountVault(nextPasswordKey, "test", "john.doe", next)).pins
      .recoveryGeneration,
  ).toBe("3");
  expect(
    (await openPasskeyVault(value.prf, value.expected, value.binding, next))
      .pins.recoveryGeneration,
  ).toBe("3");
  const rewrapped = await rewrapAccountVault(
    nextPasswordKey,
    value.passwordKey,
    next,
  );
  expect(
    (await openPasskeyVault(
      value.prf,
      value.expected,
      value.binding,
      rewrapped,
    )).pins.recoveryGeneration,
  ).toBe("3");
});

test("passkey wrappers bind the exact account, RP, credential, keys and signed ciphertext", async () => {
  const value = await fixture();
  for (
    const change of [
      { tenant: "other" },
      { subject: "jane.doe" },
      { rpId: "other.test" },
      { credentialId: base64(new Uint8Array(32)) },
      { wrappedKey: base64(new Uint8Array(40)) },
      { signature: base64(new Uint8Array(64)) },
      { extra: "field" },
      await publicIdentity(await createIdentity()),
    ]
  ) {
    await expect(
      openPasskeyVault(value.prf, value.expected, {
        ...value.binding,
        ...change,
      }, value.vault),
    ).rejects.toThrow();
  }
  for (
    const expected of [
      { ...value.expected, rpId: "other.test" },
      { ...value.expected, credentialId: base64(new Uint8Array(32)) },
      { ...value.expected, tenant: "other" },
    ]
  ) {
    await expect(
      openPasskeyVault(value.prf, expected, value.binding, value.vault),
    ).rejects.toThrow();
  }
  await expect(
    openPasskeyVault(
      new Uint8Array(32),
      value.expected,
      value.binding,
      value.vault,
    ),
  ).rejects.toThrow();
  await expect(
    openPasskeyVault(
      new Uint8Array(31),
      value.expected,
      value.binding,
      value.vault,
    ),
  ).rejects.toThrow();
  await expect(
    openAccountVaultWithKey(
      value.opened.dataKey,
      "other",
      "john.doe",
      value.vault,
    ),
  ).rejects.toThrow();
});

test("the public PRF input is stable within an RP and rejects host-confusing values", () => {
  expect(passkeyPrfInput("example.test")).toEqual(
    passkeyPrfInput("example.test"),
  );
  expect(passkeyPrfInput("example.test")).not.toEqual(
    passkeyPrfInput("other.test"),
  );
  for (
    const host of [
      "",
      "example.test/path",
      "user@example.test",
      "example.test:443",
      "example.test#fragment",
    ]
  ) {
    expect(() => passkeyPrfInput(host)).toThrow();
  }
});

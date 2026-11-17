import { afterEach, expect, test } from "bun:test";
import {
  base64,
  createAccountVault,
  createIdentity,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { acquireDataRuntime } from "./runtime/session";
import { announceDataChanges } from "./runtime/changes";

afterEach(() => lockCryptoSession());
async function account() {
  const key = base64(crypto.getRandomValues(new Uint8Array(64))),
    identity = await createIdentity();
  await acceptVault(
    key,
    await createAccountVault(key, "runtime-test", "user:1", identity, {}),
    "owner",
    false,
  );
}
function client() {
  const auth = new Set();
  return {
    listenAuthState(listener) {
      auth.add(listener);
      return () => auth.delete(listener);
    },
    authChanged() {
      for (const listener of auth) listener();
    },
  };
}

test("two facades share data lifetime without one closed facade disposing another", async () => {
  await account();
  const base = client(),
    a = new AbortController(),
    b = new AbortController();
  const first = acquireDataRuntime(base, a.signal),
    second = acquireDataRuntime(base, b.signal);
  expect(first.runtime).toBe(second.runtime);
  let changed = 0;
  second.runtime.listen(() => changed++);
  announceDataChanges(base, new Set(["test:master-data"]));
  expect(changed).toBe(1);
  a.abort();
  expect(() => first.live()).toThrow();
  second.live();
  expect(await second.runtime.read([], () => 42)).toBe(42);
  second.close();
  await expect(second.runtime.read([], () => 42)).rejects.toThrow();
  const replacement = acquireDataRuntime(base, new AbortController().signal);
  try {
    expect(replacement.runtime).not.toBe(first.runtime);
  } finally {
    replacement.close();
  }
});

test("different transports, a replaced bearer session and a locked account cannot share old decrypted state", async () => {
  await account();
  const base = client(),
    other = client(),
    signal = new AbortController().signal;
  const first = acquireDataRuntime(base, signal),
    second = acquireDataRuntime(other, signal);
  expect(first.runtime).not.toBe(second.runtime);
  base.authChanged();
  await expect(first.runtime.read([], () => 1)).rejects.toThrow();
  expect(await second.runtime.read([], () => 2)).toBe(2);
  lockCryptoSession();
  await expect(second.runtime.read([], () => 2)).rejects.toThrow();
  first.close();
  second.close();
});

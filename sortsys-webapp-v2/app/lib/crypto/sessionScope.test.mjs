import { afterEach, expect, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { captureAccountScope, lockCryptoSession } from "./session";

afterEach(() => lockCryptoSession());

test("an account scope cannot survive locking and unlocking the same account", async () => {
  const signal = new AbortController().signal;
  expect(() => captureAccountScope(signal)).toThrow(InvalidProtectedData);

  await protectedTenant([]);
  const previous = captureAccountScope(signal);
  expect(() => previous.live()).not.toThrow();

  await lockCryptoSession();
  expect(() => previous.live()).toThrow(InvalidProtectedData);

  await protectedTenant([]);
  const current = captureAccountScope(signal);
  expect(current.account.username).toBe(previous.account.username);
  expect(current.account.tenant).toBe(previous.account.tenant);
  expect(() => previous.live()).toThrow(InvalidProtectedData);
  expect(() => current.live()).not.toThrow();
});

test("an account scope retains the caller's abort reason", async () => {
  await protectedTenant([]);
  const controller = new AbortController();
  const scope = captureAccountScope(controller.signal);
  const reason = new Error("cancelled by caller");

  controller.abort(reason);
  expect(() => scope.live()).toThrow(reason);
});

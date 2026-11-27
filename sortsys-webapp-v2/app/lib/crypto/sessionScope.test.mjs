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
  expect(scope.active()).toBe(false);
  expect(() => scope.live()).toThrow(reason);
});

test("an authenticated scope stops when transport authentication ends", async () => {
  await protectedTenant([]);
  const signal = new AbortController().signal;
  let authenticated = true;
  const client = { loggedIn: () => authenticated };
  const scope = captureAccountScope(signal, client);

  expect(scope.active()).toBe(true);
  expect(() => scope.live()).not.toThrow();

  authenticated = false;
  expect(scope.active()).toBe(false);
  expect(() => scope.live()).toThrow(InvalidProtectedData);
  expect(() => captureAccountScope(signal).live()).not.toThrow();
});

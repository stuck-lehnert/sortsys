import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { runAccountCommand, waitForAccountCommands } from "./accountCommands";

afterEach(() => lockCryptoSession());

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
async function fixture() {
  await protectedTenant([]);
  const listeners = new Set();
  const client = {
    loggedIn: () => true,
    listenAuthState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { client, listeners };
}

test("a replacement view joins an unfinished account command without repeating or cancelling its write", async () => {
  const { client, listeners } = await fixture();
  const waiting = gate();
  let writes = 0;
  const command = runAccountCommand(client, async (signal) => {
    await waiting.promise;
    signal.throwIfAborted();
    writes++;
    return "published";
  });
  let joined = false;
  const view = waitForAccountCommands(
    client,
    new AbortController().signal,
  ).then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  waiting.release();
  expect(await command).toBe("published");
  await view;
  expect(writes).toBe(1);
  expect(joined).toBe(true);
  expect(listeners.size).toBe(0);
});

test("closing one view does not cancel its account command or another view waiting for it", async () => {
  const { client } = await fixture();
  const waiting = gate();
  const command = runAccountCommand(client, async (signal) => {
    await waiting.promise;
    signal.throwIfAborted();
  });
  const closed = new AbortController();
  const retired = waitForAccountCommands(client, closed.signal);
  const current = waitForAccountCommands(client, new AbortController().signal);
  const outcomes = Promise.allSettled([retired, current, command]);
  closed.abort();
  waiting.release();
  expect((await outcomes).map((outcome) => outcome.status)).toEqual([
    "rejected",
    "fulfilled",
    "fulfilled",
  ]);
});

test("an account replacement cancels the old command and a new view never joins it", async () => {
  const { client, listeners } = await fixture();
  const waiting = gate();
  const command = runAccountCommand(client, async (signal) => {
    await waiting.promise;
    signal.throwIfAborted();
  });
  const outcome = Promise.allSettled([command]);
  await fixture();
  await waitForAccountCommands(client, new AbortController().signal);
  waiting.release();
  expect((await outcome)[0].status).toBe("rejected");
  expect(listeners.size).toBe(0);
});

test("a replacement bearer session retires the pending set even when the same account stays unlocked", async () => {
  const { client, listeners } = await fixture();
  const waiting = gate();
  const command = runAccountCommand(client, async (signal) => {
    await waiting.promise;
    signal.throwIfAborted();
  });
  const outcome = Promise.allSettled([command]);
  for (const listener of [...listeners]) listener();
  await waitForAccountCommands(client, new AbortController().signal);
  waiting.release();
  expect((await outcome)[0].status).toBe("rejected");
  expect(listeners.size).toBe(0);
});

import { expect, test } from "bun:test";
import { readCachedPromise } from "../src/core/boundedPromiseCache";

test("concurrent readers share a load and failed loads can be retried", async () => {
  const entries = new Map<string, Promise<number>>();
  const failure = Promise.withResolvers<number>();
  const first = readCachedPromise(entries, "proof", 2, () => failure.promise);
  const peer = readCachedPromise(entries, "proof", 2, async () => 99);

  expect(peer).toBe(first);
  failure.reject(new Error("load failed"));
  await expect(peer).rejects.toThrow("load failed");

  const retry = readCachedPromise(entries, "proof", 2, async () => 1);
  await expect(retry).resolves.toBe(1);
  expect(readCachedPromise(entries, "proof", 2, async () => 99)).toBe(retry);
});

test("an evicted request cannot remove a replacement on rejection", async () => {
  const entries = new Map<string, Promise<number>>();
  const failure = Promise.withResolvers<number>();
  const first = readCachedPromise(entries, "proof", 1, () => failure.promise);
  await readCachedPromise(entries, "other", 1, async () => 2);
  const replacement = readCachedPromise(entries, "proof", 1, async () => 3);

  failure.reject(new Error("stale request failed"));
  await expect(first).rejects.toThrow("stale request failed");

  expect(entries.size).toBe(1);
  expect(readCachedPromise(entries, "proof", 1, async () => 99)).toBe(replacement);
  await expect(replacement).resolves.toBe(3);
});

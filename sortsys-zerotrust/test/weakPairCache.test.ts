import { expect, test } from "bun:test";
import { createWeakPairCache } from "../src/core/weakPairCache";

test("both object identities must match for an entry to be shared", () => {
  const left = { name: "client" };
  const otherLeft = { ...left };
  const right = { name: "account" };
  const otherRight = { ...right };
  let initialized = 0;
  const cache = createWeakPairCache(() => ({ sequence: ++initialized }));

  const original = cache.getOrCreate(left, right);
  expect(cache.getOrCreate(left, right)).toBe(original);
  expect(cache.getOrCreate(otherLeft, right).sequence).toBe(2);
  expect(cache.getOrCreate(left, otherRight).sequence).toBe(3);
  expect(initialized).toBe(3);
});

test("retiring an old entry cannot remove its replacement or a different pair", () => {
  const left = {};
  const right = {};
  const otherRight = {};
  const cache = createWeakPairCache(() => new Set());
  const old = cache.getOrCreate(left, right);
  const other = cache.getOrCreate(left, otherRight);

  cache.deleteIfCurrent(left, right, old);
  const replacement = cache.getOrCreate(left, right);
  expect(replacement).not.toBe(old);

  cache.deleteIfCurrent(left, right, old);
  expect(cache.getOrCreate(left, right)).toBe(replacement);
  expect(cache.getOrCreate(left, otherRight)).toBe(other);
});

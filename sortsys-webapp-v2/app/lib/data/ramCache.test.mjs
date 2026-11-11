import { expect, test } from "bun:test";
import { ramCache } from "./ramCache";

test("RPC memory cache copies buffers and evicts by both size and recency", async () => {
  const cache = ramCache(2, 6), input = new Uint8Array([1, 2, 3]);
  await cache.setBytes("a", input); input.fill(9);
  const read = await cache.getBytes("a"); read.fill(8);
  expect(Array.from(await cache.getBytes("a"))).toEqual([1, 2, 3]);
  await cache.setBytes("b", new Uint8Array([4, 5, 6]));
  await cache.getBytes("a");
  await cache.setBytes("c", new Uint8Array([7, 8]));
  expect(await cache.getBytes("b")).toBeNull();
  expect([...(await cache.keys())]).toEqual(["a", "c"]);
  await cache.setBytes("too-large", new Uint8Array(7));
  expect(await cache.getBytes("too-large")).toBeNull();
  await cache.clear(); expect(await cache.keys()).toEqual(new Set());
});

test("concurrent replacement of one cache key cannot inflate the byte budget", async () => {
  const cache = ramCache(10, 6);
  await Promise.all([cache.setBytes("a", new Uint8Array(3)), cache.setBytes("a", new Uint8Array(3))]);
  await cache.setBytes("b", new Uint8Array(3));
  expect([...(await cache.keys())]).toEqual(["a", "b"]);
});

import { expect, test } from "bun:test";
import { createCache } from "./cache";

test("the reply cache owns its bytes and evicts the least recently used entry", async () => {
  const cache = createCache(2, 20);
  const input = new Uint8Array([1, 2, 3]);
  await cache.setBytes("a", input);
  input.fill(9);

  const read = await cache.getBytes("a");
  expect(read).toEqual(new Uint8Array([1, 2, 3]));
  read!.fill(8);

  await cache.setBytes("b", new Uint8Array([4, 5, 6]));
  expect(await cache.getBytes("a")).toEqual(new Uint8Array([1, 2, 3]));
  await cache.setBytes("c", new Uint8Array([7, 8]));
  expect(await cache.keys()).toEqual(new Set(["a", "c"]));
  expect(await cache.getBytes("b")).toBeNull();
});

test("the byte budget accounts for replacements and rejects oversize entries", async () => {
  const cache = createCache(10, 6);
  const bytes = new Uint8Array(3);
  await Promise.all([cache.setBytes("a", bytes), cache.setBytes("a", bytes)]);
  await cache.setBytes("b", bytes);
  expect(await cache.keys()).toEqual(new Set(["a", "b"]));

  await cache.setBytes("b", new Uint8Array(7));
  expect(await cache.keys()).toEqual(new Set(["a"]));

  await cache.setBytes("c", new Uint8Array(4));
  expect(await cache.keys()).toEqual(new Set(["c"]));

  await cache.clear();
  await cache.setBytes("d", new Uint8Array(6));
  expect(await cache.keys()).toEqual(new Set(["d"]));
});

test("default caches are instance-local even when IndexedDB exists", async () => {
  const originals = ["window", "indexedDB"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ] as const);
  let databaseReads = 0;

  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      databaseReads++;
      throw new Error("IndexedDB must not be used for RPC replies");
    },
  });

  try {
    const first = createCache();
    const second = createCache();
    expect(await first.keys()).toEqual(new Set());
    expect(await second.keys()).toEqual(new Set());
    expect(databaseReads).toBe(0);

    const response = new Uint8Array([42]);
    await first.setBytes("result", response);
    expect(await second.getBytes("result")).toBeNull();
    expect(await first.getBytes("result")).toEqual(response);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

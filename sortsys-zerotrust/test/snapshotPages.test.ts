import { expect, test } from "bun:test";
import { collectSnapshotPages, readSnapshotPages } from "../src/index";

test("snapshot pagination preserves order, empty filtered pages and a fixed snapshot", async () => {
  const requests: unknown[] = [];
  const pages = [
    { snapshot: "catalog:7", items: ["a", "b"], after: "b" },
    { snapshot: "catalog:7", items: [], after: "d" },
    { snapshot: "catalog:7", items: ["e"], after: null },
  ];
  const items = await collectSnapshotPages({
    maxItems: 2,
    read: async request => {
      requests.push(request);
      return pages.shift()!;
    },
  });
  expect(items).toEqual(["a", "b", "e"]);
  expect(requests).toEqual([
    { snapshot: null, after: null },
    { snapshot: "catalog:7", after: "b" },
    { snapshot: "catalog:7", after: "d" },
  ]);
});

test("changed snapshots, oversized pages and cursor loops never yield an unchecked page", async () => {
  for (const invalid of [
    { snapshot: "other", items: ["secret"], after: null },
    { snapshot: "stable", items: ["a", "b", "c"], after: null },
    { snapshot: "stable", items: ["secret"], after: "first" },
  ]) {
    const delivered: string[] = [];
    let calls = 0;
    await expect((async () => {
      for await (const page of readSnapshotPages({
        snapshot: "stable",
        maxItems: 2,
        read: async () => {
          calls++;
          if (calls === 1) return { snapshot: "stable", items: ["safe"], after: "first" };
          return invalid;
        },
      })) delivered.push(...page);
    })()).rejects.toThrow();
    expect(delivered).toEqual(["safe"]);
    expect(calls).toBe(2);
  }
});

test("cancellation prevents a late page from reaching the consumer", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(collectSnapshotPages({
    maxItems: 1,
    signal: controller.signal,
    read: async () => {
      calls++;
      controller.abort();
      return { snapshot: "stable", items: ["late"], after: null };
    },
  })).rejects.toThrow();
  expect(calls).toBe(1);
});

test("stopping the iterator does not prefetch another page", async () => {
  let calls = 0;
  for await (const page of readSnapshotPages({
    maxItems: 1,
    read: async () => {
      calls++;
      return { snapshot: "stable", items: ["a"], after: "next" };
    },
  })) {
    expect(page).toEqual(["a"]);
    break;
  }
  expect(calls).toBe(1);
});

test("page tokens remain opaque while sharing Rust's UTF-8 byte limits", async () => {
  const { validatePageToken } = await import("../src/index");
  expect(() => validatePageToken('-etag/"two"')).not.toThrow();
  expect(() => validatePageToken("ä".repeat(1024))).not.toThrow();
  expect(() => validatePageToken("ä".repeat(1025))).toThrow();
  expect(() => validatePageToken("\ud800")).toThrow();
  const items = await collectSnapshotPages({
    maxItems: 1,
    snapshot: '-etag/"two"',
    read: async () => ({ snapshot: '-etag/"two"', items: [1], after: null }),
  });
  expect(items).toEqual([1]);
});

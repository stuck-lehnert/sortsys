import { expect, test } from "bun:test";
import { readExportReferences } from "./exportReferences.ts";

test("exports use one cache-first query per distinct nonempty reference", async () => {
  const calls = [];
  const visible = { id: "a", firstName: "Ada" };
  const client = {
    async query(path, { id }, options) {
      calls.push([path, id, options.strategy]);
      return id === "a" ? [visible, null] : [null, { code: "FORBIDDEN" }];
    },
  };

  const ids = ["a", null, "b", "a", undefined, "", "b"];
  const result = await readExportReferences(client, "users.get", ids);

  expect(calls).toEqual([
    ["users.get", "a", "cache-first"],
    ["users.get", "b", "cache-first"],
  ]);
  expect([...result]).toEqual([["a", visible], ["b", null]]);
});

test("a new export does not retain records from an earlier query", async () => {
  const visible = { id: "p", name: "Stahl" };
  let accessible = true;
  const client = {
    async query() {
      return accessible ? [visible, null] : [null, { code: "FORBIDDEN" }];
    },
  };

  const before = await readExportReferences(client, "products.get", ["p"]);
  accessible = false;
  const after = await readExportReferences(client, "products.get", ["p"]);

  expect(before.get("p")).toBe(visible);
  expect(after.get("p")).toBe(null);
});

test("large exports bound concurrent reads without dropping references", async () => {
  let active = 0;
  let peak = 0;
  const client = {
    async query(_path, { id }) {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return [{ id }, null];
    },
  };
  const ids = Array.from({ length: 15 }, (_, index) => `product-${index}`);

  const result = await readExportReferences(client, "products.get", ids);

  expect(peak).toBe(4);
  expect([...result]).toEqual(ids.map((id) => [id, { id }]));
});

test("an export propagates a thrown query error", async () => {
  const error = new Error("account changed");
  const client = {
    async query() {
      throw error;
    },
  };

  await expect(readExportReferences(client, "tools.get", ["t"])).rejects.toThrow(error);
});

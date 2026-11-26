import { expect, test } from "bun:test";
import {
  readDeliveryExportCosts,
  readExportReferences,
  readRegieExportReferences,
} from "./exportReferences.ts";

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

test("regie exports read material and staff together without repeating references", async () => {
  const started = [];
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const product = { id: "a", name: "Stahl" };
  const client = {
    async query(path, { id }, { strategy }) {
      started.push([path, id, strategy]);
      await ready;

      if (path === "products.get") return [product, null];
      return [null, { code: "FORBIDDEN" }];
    },
  };
  const report = {
    products: [{ productId: "a" }],
    workHours: [{ userId: "a" }],
  };

  const reading = readRegieExportReferences(client, [report, report]);
  release();
  expect(started).toEqual([
    ["products.get", "a", "cache-first"],
    ["users.get", "a", "cache-first"],
  ]);

  const { productsById, usersById } = await reading;
  expect([...productsById]).toEqual([["a", product]]);
  expect([...usersById]).toEqual([["a", null]]);
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

test("delivery export cost reads share the parallel limit and retain note order", async () => {
  let active = 0;
  let peak = 0;
  const calls = [];
  const client = {
    async query(path, { id }, { strategy }) {
      calls.push([path, id, strategy]);
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return [id === "missing" ? null : { totalCost: Number(id) }, null];
    },
  };
  const ids = ["3", "2", "1", "missing", "4", "5"];

  const result = await readDeliveryExportCosts(client, [...ids, "3"]);

  expect(peak).toBe(4);
  expect(calls).toEqual(ids.map((id) => ["deliveryNotes.costs.get", id, "cache-first"]));
  expect([...result]).toEqual([
    ["3", { totalCost: 3 }],
    ["2", { totalCost: 2 }],
    ["1", { totalCost: 1 }],
    ["missing", null],
    ["4", { totalCost: 4 }],
    ["5", { totalCost: 5 }],
  ]);
});

test("a returned error reading delivery costs does not become a missing note", async () => {
  const error = new Error("Keine Freigabe für Beschaffung");
  const client = {
    async query() {
      return [null, error];
    },
  };

  await expect(readDeliveryExportCosts(client, ["3"])).rejects.toThrow(error);
});

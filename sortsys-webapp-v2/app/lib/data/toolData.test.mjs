import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import {
  TOOL_INDEX,
  TOOL_INDEX_MODEL,
  TOOL_MODEL,
  bookingToolSummary,
  toolChanges,
  toolCollection,
  toolDomain,
  toolPart,
  toolQueryAffected,
} from "./toolData";
import { openDataDocument, UNLOADED } from "./runtime/model";
import { DataRow, projectDataRows } from "./runtime/rows";

const source = () =>
  row("tools", {
    id: "100",
    custom_id: "73",
    brand: "Muster",
    category: "Bohrhammer",
    label: "Sanierung Nordflügel",
    purchase_price: 1537.87654321,
    usage_cost_per_day: 17.375,
  });

test("tool query invalidation follows actual data dependencies and preserves unrelated pending reads", () => {
  const change = (path, domain) => toolQueryAffected(path, new Set([domain]));
  expect(change("tools.get", "tool-tracking:35:master-data")).toBe(false);
  expect(change("tools.get", "tool-tracking:35:scope")).toBe(false);
  expect(change("tools.get", "tool:34:master-data")).toBe(true);
  expect(change("tools.get", "tool:34:procurement")).toBe(true);
  expect(change("tools.get", "tool:34:measurement")).toBe(false);
  expect(change("tools.brands", "tool:34:procurement")).toBe(false);
  expect(change("tools.categories", "tool:34:master-data")).toBe(true);
  expect(change("tools.trackings.list", "tool:34:master-data")).toBe(false);
  expect(change("tools.trackings.list", "tool-tracking:35:scope")).toBe(false);
  expect(change("tools.trackings.list", "tool-tracking:35:procurement")).toBe(
    true,
  );
  expect(
    change("tools.trackings.transfers.list", "tool-tracking:35:scope"),
  ).toBe(true);
  expect(change("tools.inventories.list", "tool:34:master-data")).toBe(false);
  expect(change("tools.inventories.list", "tool:34:measurement")).toBe(true);
  expect(
    change("tools.inventories.overview", "tool-tracking:35:master-data"),
  ).toBe(true);
  expect(change("tools.inventories.overview", "tool:34:procurement")).toBe(
    false,
  );
  expect(change("tools.suggestNextCustomId", TOOL_INDEX.domain)).toBe(true);
  expect(change("tools.list", TOOL_INDEX.domain)).toBe(false);
  expect(toolQueryAffected("tools.get")).toBe(true);
  expect(toolQueryAffected("projects.get")).toBe(false);
});

test("booking labels retain exact tool references without copying cost fields", () => {
  const summary = bookingToolSummary(source());
  expect(summary).toEqual({
    id: "34",
    customId: 73,
    brand: "Muster",
    category: "Bohrhammer",
    label: "Sanierung Nordflügel",
  });
  const tracking = row("tool_trackings", {
    id: "101",
    tool_id: "100",
    responsible_user_id: "5",
    tool_usage_cost_per_day: 17.375,
  });
  const area = toolCollection("tool-tracking", "35", "master-data");
  const original = toolPart(
    "tool-tracking",
    "35",
    "master-data",
    [tracking],
    null,
    summary,
  );
  expect(TOOL_MODEL.decode(original, area.prefix, area).toolSummary).toEqual(
    summary,
  );
  for (const corrupt of [
    (value) => {
      value.toolSummary.purchasePrice = 100;
    },
    (value) => {
      value.toolSummary.id = "36";
    },
    (value) => {
      value.toolSummary.customId = 0;
    },
    (value) => {
      value.toolSummary.brand = "";
    },
  ]) {
    const value = structuredClone(original);
    corrupt(value);
    expect(() => TOOL_MODEL.decode(value, area.prefix, area)).toThrow();
  }
});
function opened(namespace, id, facet, rows, active = null) {
  const area = toolCollection(namespace, id, facet),
    value = toolPart(namespace, id, facet, rows, active);
  return openDataDocument(TOOL_MODEL, area, {
    envelope: { object: area.prefix, revision: "1" },
    value,
  });
}
test("tool master data, costs, inventories and individual tracking records have independent field ownership", () => {
  const tool = source(),
    master = opened("tool", "34", "master-data", [tool], "35"),
    prices = opened("tool", "34", "procurement", [tool]);
  expect(JSON.stringify(master.value)).not.toContain("purchase_price");
  expect(JSON.stringify(master.value)).not.toContain("usage_cost_per_day");
  const unavailable = new DataRow(
    [...projectDataRows([master]).get("tools").values()][0],
    () => {},
  );
  expect(unavailable.get("purchase_price")).toBe(UNLOADED);
  expect(unavailable.get("label")).toBe("Sanierung Nordflügel");
  const merged = new DataRow(
    [...projectDataRows([master, prices]).get("tools").values()][0],
    () => {},
  );
  expect(merged.require("purchase_price")).toBe(1537.87654321);
  expect(merged.require("usage_cost_per_day")).toBe(17.375);
  const tracking = row("tool_trackings", {
    id: "101",
    tool_id: "100",
    responsible_user_id: "5",
    tool_usage_cost_per_day: 17.375,
  });
  const assigned = opened("tool-tracking", "35", "master-data", [tracking]),
    historicalCost = opened("tool-tracking", "35", "procurement", [tracking]);
  expect(JSON.stringify(assigned.value)).not.toContain(
    "tool_usage_cost_per_day",
  );
  expect(
    new DataRow(
      [
        ...projectDataRows([assigned, historicalCost])
          .get("tool_trackings")
          .values(),
      ][0],
      () => {},
    ).require("tool_usage_cost_per_day"),
  ).toBe(17.375);
  expect(assigned.area.scope).not.toBe(master.area.scope);
});
test("tool payloads reject private-field injection, resource substitution, broken cells and invalid tombstones", () => {
  const area = toolCollection("tool", "34", "master-data"),
    original = toolPart("tool", "34", "master-data", [source()]);
  for (const corrupt of [
    (value) => {
      value.rows[0].values.purchase_price = 17;
    },
    (value) => {
      value.rows[0].values.id = "101";
    },
    (value) => {
      value.rows[0].values.brand = "";
    },
    (value) => {
      value.rows[0].values.extra = "unexpected";
    },
    (value) => {
      value.rows[0].values.custom_id = "2147483648";
    },
    (value) => {
      value.deleted = true;
    },
    (value) => {
      value.activeTrackingId = "00";
    },
    (value) => {
      value.schema = "unknown";
    },
  ]) {
    const value = structuredClone(original);
    corrupt(value);
    expect(() => TOOL_MODEL.decode(value, area.prefix, area)).toThrow();
  }
  expect(() =>
    TOOL_MODEL.decode(original, area.prefix, { ...area, scope: "tool:35" }),
  ).toThrow();
  expect(() => toolCollection("tool", "34", "scope")).toThrow();
  expect(toolDomain("tool:34:scope")).toBeNull();
  const inventory = row("tool_inventories", { id: "1", tool_id: "101" }),
    value = toolPart("tool", "34", "measurement", [inventory]),
    part = toolCollection("tool", "34", "measurement");
  expect(() => TOOL_MODEL.decode(value, part.prefix, part)).toThrow();
  expect(
    TOOL_MODEL.decode(
      { ...original, deleted: true, rows: [] },
      area.prefix,
      area,
    ).deleted,
  ).toBe(true);
});
test("the encrypted number index reserves unique tool numbers without publishing business names or prices", () => {
  const valid = {
    format: "sortsys-tool-index-v1",
    entries: [{ id: "34", customId: 73 }],
  };
  expect(TOOL_INDEX_MODEL.decode(valid, TOOL_INDEX.prefix, TOOL_INDEX)).toEqual(
    valid,
  );
  for (const entry of [
    { id: "35", customId: 73 },
    { id: "34", customId: 74 },
    { id: "35", customId: 0 },
    { id: "35", customId: 2147483648 },
    { id: "35", customId: "74" },
  ])
    expect(() =>
      TOOL_INDEX_MODEL.decode(
        { ...valid, entries: [...valid.entries, entry] },
        TOOL_INDEX.prefix,
        TOOL_INDEX,
      ),
    ).toThrow();
  expect(
    toolChanges(
      {
        customId: 74,
        brand: "Muster",
        category: "Gerüst",
        purchasePrice: 17.375,
      },
      true,
    ).purchase_price,
  ).toBe(17.375);
  for (const value of [-1, Infinity, NaN, "17,5"])
    expect(() => toolChanges({ usageCostPerDay: value })).toThrow();
  expect(() => toolChanges({ customId: 123 })).toThrow();
  expect(() => toolChanges({ extra: true })).toThrow();
});

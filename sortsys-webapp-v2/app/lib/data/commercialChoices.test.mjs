import { afterEach, expect, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { createProtectedCommercial } from "./commercial";
import { commercialCollection } from "./commercialAreas";
import { splitCommercialRows } from "./commercialData";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { announceDataChanges } from "./runtime/changes";
import { CUSTOMER_COLLECTION } from "./addressBook";

afterEach(() => lockCryptoSession());

async function unusedDependency() {
  throw new Error("A document choice must not load related business records");
}

test("document choices batch only verified headers and never open price or calculation records", async () => {
  const ids = [100, 101, 102].map((id) => id.toString(32));
  const unsharedHeader = commercialCollection("37", "master-data");
  const privatePrice = commercialCollection("37", "offer-prices");
  const areas = ids.flatMap((id) => [
    commercialCollection(id, "master-data"),
    commercialCollection(id, "offer-prices"),
    commercialCollection(id, "calculation"),
  ]);
  areas.push(unsharedHeader, privatePrice);
  const tenant = await protectedTenant(areas, (area) => {
    if (area.domain === unsharedHeader.domain) return [];
    return [...ACTIONS];
  });
  await tenant.seed(privatePrice, `${privatePrice.prefix}case`, {
    invalid: true,
  });
  for (const [index, id] of ids.entries()) {
    // The last header has no document yet and must not produce an empty choice.
    if (index === 2) continue;
    const parts = splitCommercialRows(id, [
      row("commercial_cases", {
        id: String(100 + index),
        title: `Fassadenarbeiten Bauabschnitt ${index + 1}`,
        reference: `ANG-26-${index + 1}`,
        kind: "offer",
        status: "draft",
        scope_item_ids: "[]",
        net_amount: "123456.78",
        notes: "Vertraulicher Kalkulationsansatz",
      }),
    ]);
    const header = commercialCollection(id, "master-data");
    await tenant.seed(header, `${header.prefix}case`, parts.get("master-data"));
    // These encrypted records deliberately fail the business decoder. A
    // header-only choice must succeed without reading or decoding them.
    for (const facet of ["offer-prices", "calculation"]) {
      const area = commercialCollection(id, facet);
      await tenant.seed(area, `${area.prefix}case`, { invalid: true });
    }
  }
  tenant.calls.length = 0;
  const store = createProtectedCommercial(
    tenant.client,
    new AbortController().signal,
    unusedDependency,
    unusedDependency,
    duckDriver,
  );
  try {
    expect(await store.choices()).toEqual(
      ids.slice(0, 2).map((id, index) => ({
        id,
        title: `Fassadenarbeiten Bauabschnitt ${index + 1}`,
        reference: `ANG-26-${index + 1}`,
      })),
    );
    const batches = tenant.calls.filter(
      (call) => call.path === "zerotrust.objects.pages",
    );
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.some((call) => call.input.selections.length > 1)).toBe(true);
    const reads = tenant.calls.filter((call) =>
      [
        "zerotrust.objects.pages",
        "zerotrust.objects.list",
        "zerotrust.objects.get",
      ].includes(call.path),
    );
    for (const call of reads) {
      const selections = call.input.selections ?? [call.input];
      for (const selection of selections) {
        expect(selection.domain.endsWith(":master-data")).toBe(true);
      }
    }
    expect(JSON.stringify(tenant.calls)).not.toContain("Fassadenarbeiten");
    expect(JSON.stringify(tenant.calls)).not.toContain("Kalkulationsansatz");
    store.close();
    const callsBeforeClosedRead = tenant.calls.length;
    await expect(store.choices()).rejects.toThrow();
    expect(tenant.calls).toHaveLength(callsBeforeClosedRead);
  } finally {
    store.close();
  }
});

test("concurrent searches share one running case inventory and the next search observes a fresh read", async () => {
  const areas = ["34", "35"].map((id) =>
    commercialCollection(id, "master-data"),
  );
  const tenant = await protectedTenant(areas);
  for (const [index, area] of areas.entries()) {
    const values = splitCommercialRows(area.prefix.split(":")[1], [
      row("commercial_cases", {
        id: String(100 + index),
        title: index === 0 ? "Innenputz" : "Außenputz",
        reference: `ANG-26-${index + 1}`,
        kind: "offer",
        status: "draft",
        scope_item_ids: "[]",
      }),
    ]);
    await tenant.seed(area, `${area.prefix}case`, values.get("master-data"));
  }
  const original = tenant.client.query;
  let scans = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.access.snapshot") {
      scans++;
      await blocked;
    }
    return original(path, input, options);
  };
  const store = createProtectedCommercial(
    tenant.client,
    new AbortController().signal,
    unusedDependency,
    unusedDependency,
    duckDriver,
  );
  try {
    const first = store.query("commercial.cases.list", {
      kind: "offer",
      search: "Innen",
    });
    const second = store.query("commercial.cases.list", {
      kind: "offer",
      search: "Außen",
    });
    expect(scans).toBe(1);
    release();
    const complete = store.query("commercial.cases.list", {
      kind: "offer",
      search: "putz",
    });
    const [inside, outside, all] = await Promise.all([first, second, complete]);
    expect(inside.map((value) => value.title)).toEqual(["Innenputz"]);
    expect(outside.map((value) => value.title)).toEqual(["Außenputz"]);
    inside[0].scopeItemIds.push("changed-by-one-reader");
    expect(all.find((value) => value.id === inside[0].id).scopeItemIds).toEqual(
      [],
    );
    await store.query("commercial.cases.list", {
      kind: "offer",
      search: "putz",
    });
    expect(scans).toBe(2);
    const failure = new Error("Inventory temporarily unavailable");
    tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.access.snapshot") {
        scans++;
        return [null, failure];
      }
      return original(path, input, options);
    };
    const rejected = await Promise.allSettled([
      store.query("commercial.cases.list", { kind: "offer", search: "Innen" }),
      store.query("commercial.cases.list", { kind: "offer", search: "Außen" }),
    ]);
    expect(scans).toBe(3);
    expect(rejected.map((value) => value.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    tenant.client.query = original;
    expect(
      (await store.query("commercial.cases.list", { kind: "offer" })).length,
    ).toBe(2);
    for (const change of [
      { domains: new Set(["preferences:user:1:master-data"]), detached: false },
      { domains: new Set([areas[0].domain]), detached: true },
      { domains: new Set([CUSTOMER_COLLECTION.domain]), detached: true },
      { options: { control: true, revalidate: true }, detached: true },
    ]) {
      let resume;
      const held = new Promise((resolve) => {
        resume = resolve;
      });
      let inventories = 0;
      tenant.client.query = async (path, input, options) => {
        if (path === "zerotrust.access.snapshot") {
          inventories++;
          await held;
        }
        return original(path, input, options);
      };
      const previous = store.query("commercial.cases.list", { kind: "offer" });
      expect(inventories).toBe(1);
      announceDataChanges(tenant.client, change.domains, change.options);
      const current = store.query("commercial.cases.list", { kind: "offer" });
      expect(inventories).toBe(change.detached ? 2 : 1);
      resume();
      expect(
        (await Promise.all([previous, current])).map((values) => values.length),
      ).toEqual([2, 2]);
    }
  } finally {
    release();
    store.close();
  }
});

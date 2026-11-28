import { afterEach, expect, spyOn, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { publicId } from "./products";
import { DataView } from "./runtime/runtime";
import { createProtectedTools } from "./tools";
import { toolBookingArea, toolCollection, toolPart } from "./toolData";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

test("booking lists reuse the loaded records when resolving transfers", async () => {
  const endedAt = "2026-11-12T11:00:00Z";
  const bookings = [
    { id: "101", toolId: "21", projectId: "5", endedAt: null },
    { id: "102", toolId: "22", projectId: "5", endedAt },
    { id: "103", toolId: "23", projectId: "6", endedAt: null },
  ].map((booking) => ({
    ...booking,
    master: toolCollection("tool-tracking", publicId(booking.id), "master-data"),
    scope: toolCollection("tool-tracking", publicId(booking.id), "scope"),
  }));
  const hidden = bookings[2].master;
  const tenant = await protectedTenant(
    bookings.flatMap(({ master, scope }) => [master, scope]),
    (area) => (area === hidden ? [] : [...ACTIONS]),
  );

  for (const booking of bookings) {
    const id = publicId(booking.id);
    const tracking = row("tool_trackings", {
      id: booking.id,
      tool_id: booking.toolId,
      project_id: booking.projectId,
      started_at: "2026-11-12T08:00:00Z",
      ended_at: booking.endedAt,
    });
    const transfer = row("tool_tracking_transfer_requests", {
      id: booking.id,
      tool_tracking_id: booking.id,
      transfer_to_user_id: "2",
      status: "open",
    });

    await tenant.seed(
      booking.master,
      booking.master.prefix,
      toolPart("tool-tracking", id, "master-data", [tracking]),
    );
    await tenant.seed(
      booking.scope,
      booking.scope.prefix,
      toolPart("tool-tracking", id, "scope", [transfer]),
    );
  }

  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("Bookings do not open project contents");
    },
    duckDriver,
  );
  const documents = spyOn(DataView.prototype, "documents");

  try {
    const active = await store.query("tools.trackings.list", {
      projectId: publicId("5"),
      finished: false,
    });
    expect(active.map(({ id }) => id)).toEqual([publicId("101")]);

    const transfers = await store.query("tools.trackings.transfers.list", {});
    const results = transfers.map(({ toolTrackingId, toolId, status }) =>
      [toolTrackingId, toolId, status],
    );
    expect(results.sort()).toEqual([
      [publicId("101"), publicId("21"), "open"],
      [publicId("102"), publicId("22"), "denied"],
    ]);

    // For each read, one copy checks presence and one supplies the result.
    const masterCopies = documents.mock.calls
      .map(([{ area }]) => area)
      .filter(({ facet }) => facet === "master-data");
    expect(masterCopies).toHaveLength(8);
    expect(masterCopies.map(({ domain }) => domain)).not.toContain(hidden.domain);
  } finally {
    documents.mockRestore();
    store.close();
  }
});

test("one tool read checks its description, booking state and costs without paging the tenant inventory", async () => {
  const master = toolCollection("tool", "34", "master-data");
  const cost = toolCollection("tool", "34", "procurement");
  const unrelated = toolCollection("tool-tracking", "35", "master-data");
  const tenant = await protectedTenant([master, cost, unrelated]);
  const source = row("tools", {
    id: "100",
    custom_id: "73",
    brand: "Muster",
    category: "Bohrhammer",
    purchase_price: 1357.5,
    usage_cost_per_day: 17.375,
  });
  await tenant.seed(
    master,
    master.prefix,
    toolPart("tool", "34", "master-data", [source]),
  );
  await tenant.seed(
    cost,
    cost.prefix,
    toolPart("tool", "34", "procurement", [source]),
  );
  await tenant.seed(unrelated, unrelated.prefix, { invalid: true });
  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("A tool read must not open project data");
    },
    duckDriver,
  );
  try {
    tenant.calls.length = 0;
    const result = await store.query("tools.get", { id: "34" });
    expect(result.id).toBe("34");
    expect(result.purchasePrice).toBe(1357.5);
    expect(result.usageCostPerDay).toBe(17.375);
    const snapshots = tenant.calls.filter(
      (call) => call.path === "zerotrust.access.snapshot",
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].input.domains).toEqual([master.domain, cost.domain]);
    expect(
      tenant.calls.some((call) => call.path === "zerotrust.access.page"),
    ).toBe(false);
    const reads = tenant.calls.filter(
      (call) => call.path === "zerotrust.objects.pages",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads)
      expect(
        read.input.selections.map((selection) => selection.prefix).sort(),
      ).toEqual(
        [master.prefix, toolBookingArea("34").prefix, cost.prefix].sort(),
      );
    tenant.calls.length = 0;
    await expect(store.query("tools.get", { id: "034" })).rejects.toThrow();
    expect(tenant.calls).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("tool lists join costs by resource without opening an unshared cost area", async () => {
  const own = toolCollection("tool", "34", "procurement");
  const hidden = toolCollection("tool", "35", "procurement");
  const master = ["34", "35"].map((id) =>
    toolCollection("tool", id, "master-data"),
  );
  const tenant = await protectedTenant(
    [...master, own, hidden],
    (area) => area === hidden ? [] : [...ACTIONS],
  );

  for (const [index, area] of master.entries()) {
    const source = row("tools", {
      id: String(100 + index),
      custom_id: String(73 + index),
      brand: "Muster",
      category: "Bohrhammer",
      purchase_price: 100 + index,
      usage_cost_per_day: 0,
    });
    const id = area.scope.split(":")[1];
    const cost = index === 0 ? own : hidden;

    await tenant.seed(
      area,
      area.prefix,
      toolPart("tool", id, "master-data", [source]),
    );
    await tenant.seed(
      cost,
      cost.prefix,
      toolPart("tool", id, "procurement", [source]),
    );
  }

  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("A tool list must not open project data");
    },
    duckDriver,
  );

  try {
    tenant.calls.length = 0;
    const visible = await store.query("tools.list", {});

    expect(visible.map(({ id, purchasePrice, usageCostPerDay }) => ({
      id, purchasePrice, usageCostPerDay,
    }))).toEqual([
      { id: "34", purchasePrice: 100, usageCostPerDay: 0 },
      { id: "35", purchasePrice: null, usageCostPerDay: null },
    ]);

    const selected = tenant.calls
      .filter(({ path }) => path === "zerotrust.objects.pages")
      .flatMap(({ input }) => input.selections.map(({ prefix }) => prefix));
    expect(selected).toContain(own.prefix);
    expect(selected).not.toContain(hidden.prefix);
  } finally {
    store.close();
  }
});

test("tool and booking choices read only permitted master data and reuse one access snapshot per read", async () => {
  const master = toolCollection("tool", "34", "master-data");
  const cost = toolCollection("tool", "34", "procurement");
  const booking = toolCollection("tool-tracking", "35", "master-data");
  const bookingCost = toolCollection("tool-tracking", "35", "procurement");
  const unshared = toolCollection("tool", "36", "master-data");
  const unrelatedBooking = toolCollection("tool-tracking", "37", "master-data");
  const tenant = await protectedTenant(
    [master, cost, booking, bookingCost, unshared, unrelatedBooking],
    (area) => (area === unshared ? [] : [...ACTIONS]),
  );
  const source = row("tools", {
    id: "100",
    custom_id: "73",
    brand: "Muster",
    category: "Bohrhammer",
    label: "Sanierung Nordflügel",
    purchase_price: 1537.87654321,
    usage_cost_per_day: 17.375,
  });
  await tenant.seed(
    master,
    master.prefix,
    toolPart("tool", "34", "master-data", [source], "35"),
  );
  await tenant.seed(cost, cost.prefix, { invalid: true });
  await tenant.seed(bookingCost, bookingCost.prefix, { invalid: true });
  for (const [area, toolId, bookingId] of [
    [booking, "100", "101"],
    [unrelatedBooking, "102", "103"],
  ]) {
    const source = row("tool_trackings", {
      id: bookingId,
      tool_id: toolId,
      started_at: "2026-11-09T08:15:00Z",
      ended_at: null,
      tool_usage_cost_per_day: 17.375,
    });
    await tenant.seed(
      area,
      area.prefix,
      toolPart("tool-tracking", area.scope.split(":")[1], "master-data", [
        source,
      ]),
    );
  }
  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("Choices must not load project contents");
    },
    duckDriver,
  );
  try {
    tenant.calls.length = 0;
    const tools = await store.choices();
    expect(tools).toEqual([
      {
        id: "34",
        customId: 73,
        brand: "Muster",
        category: "Bohrhammer",
        label: "Sanierung Nordflügel",
      },
    ]);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.access.snapshot"),
    ).toHaveLength(1);
    tenant.calls.length = 0;
    const choices = await store.trackingChoices();
    expect(choices).toEqual([
      {
        id: "35",
        tool: tools[0],
        startedAt: new Date("2026-11-09T08:15:00Z"),
        endedAt: null,
      },
      {
        id: "37",
        tool: null,
        startedAt: new Date("2026-11-09T08:15:00Z"),
        endedAt: null,
      },
    ]);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.access.snapshot"),
    ).toHaveLength(1);
    const reads = tenant.calls.filter((call) =>
      [
        "zerotrust.objects.pages",
        "zerotrust.objects.list",
        "zerotrust.objects.get",
      ].includes(call.path),
    );
    const cachedMasterReads = reads
      .filter((call) => call.path === "zerotrust.objects.pages")
      .flatMap((call) => call.input.selections ?? [call.input])
      .filter((request) => request.domain === master.domain);
    const masterHead = String(tenant.domains.get(master.domain).head);
    expect(cachedMasterReads).toHaveLength(2);
    expect(cachedMasterReads[0]).toMatchObject({
      known: masterHead,
      snapshot: null,
    });
    expect(cachedMasterReads[1]).toMatchObject({
      headOnly: true,
      snapshot: masterHead,
    });
    for (const call of reads) {
      for (const selected of call.input.selections ?? [call.input]) {
        expect(selected.domain.endsWith(":master-data")).toBe(true);
        expect(selected.domain).not.toBe(unshared.domain);
      }
    }
    expect(JSON.stringify(tenant.calls)).not.toContain("Sanierung Nordflügel");
    expect(await store.searchChoices("sanierung nord")).toEqual(tools);
    expect(await store.searchChoices("73")).toEqual(tools);
    expect(await store.searchChoices("fehlend")).toEqual([]);
    store.close();
    const calls = tenant.calls.length;
    await expect(store.choices()).rejects.toThrow();
    expect(tenant.calls).toHaveLength(calls);
  } finally {
    store.close();
  }
});

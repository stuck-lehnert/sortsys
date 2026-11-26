import { afterEach, expect, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { publicId } from "./products";
import { toolCollection, toolPart } from "./toolData";
import { createProtectedTools } from "./tools";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

test("inventory overview selects the latest readable inventory and booking per tool", async () => {
  const areas = [];
  const unreadable = new Set();
  const fixtures = [];
  function add(namespace, decimalId, facet, rows, readable = true) {
    const id = publicId(decimalId);
    const area = toolCollection(namespace, id, facet);
    areas.push(area);
    if (!readable) unreadable.add(area.domain);
    fixtures.push({ area, part: toolPart(namespace, id, facet, rows) });
  }

  const day = 86_400_000;
  const now = Date.now();
  const recent = new Date(now - day).toISOString();
  const earlier = new Date(now - 2 * day).toISOString();
  const old = new Date(now - 31 * day).toISOString();
  for (const [toolId, inventories, canReadInventory] of [
    ["100", [recent, earlier], true],
    ["200", [old], true],
    ["300", [recent], false],
    ["400", [], true],
  ]) {
    add("tool", toolId, "master-data", [
      row("tools", { id: toolId, custom_id: toolId, brand: "Muster" }),
    ]);
    add(
      "tool",
      toolId,
      "measurement",
      inventories.map((createdAt, index) =>
        row("tool_inventories", {
          id: String(Number(toolId) + index),
          tool_id: toolId,
          created_at: createdAt,
        }),
      ),
      canReadInventory,
    );
  }

  for (const [bookingId, toolId, userId, startedAt, readable] of [
    ["63", "100", "91", "2026-11-12T08:00:00.000001Z", true],
    ["31", "100", "92", "2026-11-12T08:00:00.000002Z", true],
    ["32", "100", "93", "2026-11-12T09:00:00.000002+01:00", true],
    ["64", "100", "94", "2026-11-12T08:00:00.000003Z", false],
    ["65", "200", "95", "2026-11-12T09:00:00Z", true],
  ]) {
    add(
      "tool-tracking",
      bookingId,
      "master-data",
      [
        row("tool_trackings", {
          id: bookingId,
          tool_id: toolId,
          started_at: startedAt,
          ended_at: "2026-11-12T10:00:00Z",
          responsible_user_id: userId,
        }),
      ],
      readable,
    );
  }

  const tenant = await protectedTenant(areas, (area) =>
    unreadable.has(area.domain) ? [] : [...ACTIONS],
  );
  for (const { area, part } of fixtures)
    await tenant.seed(area, area.prefix, part);

  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("Inventory overview does not read project data");
    },
    duckDriver,
  );

  try {
    const overview = async (hadInventory) => {
      const tools = await store.query("tools.inventories.overview", {
        days: 30,
        hadInventory,
      });
      return tools.map((tool) => [
        tool.id,
        tool.lastInventoryAt?.toISOString() ?? null,
        tool.lastResponsibleUserId,
      ]);
    };

    expect(await overview(true)).toEqual([
      [publicId("100"), recent, publicId("93")],
    ]);
    expect(await overview(false)).toEqual([
      [publicId("200"), old, publicId("95")],
      [publicId("400"), null, null],
    ]);
    expect(
      await store.query("tools.inventories.list", { toolId: publicId("100") }),
    ).toMatchObject([{ createdAt: new Date(recent) }, { createdAt: new Date(earlier) }]);

    const readDomains = tenant.calls
      .filter((call) => call.path === "zerotrust.objects.pages")
      .flatMap((call) =>
        call.input.selections.map((selection) => selection.domain),
      );
    expect(readDomains).toContain(
      toolCollection("tool", publicId("100"), "measurement").domain,
    );
    for (const domain of unreadable) expect(readDomains).not.toContain(domain);
  } finally {
    store.close();
  }
}, 60_000);

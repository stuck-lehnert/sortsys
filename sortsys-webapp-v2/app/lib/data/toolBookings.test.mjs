import { afterEach, expect, test } from "bun:test";
import {
  ACTIONS,
  accountRequestFingerprint,
  CREATION_FACETS,
  immutableObject,
  immutablePrefix,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession, unlockedAccount } from "../crypto/session";
import { ProtectedWriteConflict } from "./atomicWrites";
import { toolBookingInput, toolBookingTargets } from "./toolBookings";
import { toolBookingArea, toolCollection, toolPart } from "./toolData";
import { createProtectedTools } from "./tools";
import { toolUsageCollection, toolUsagePart } from "./projectToolUsage";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture(options = {}) {
  const master = toolCollection("tool", "34", "master-data");
  const price = toolCollection("tool", "34", "procurement");
  const second = toolCollection("tool", "35", "master-data");
  const secondPrice = toolCollection("tool", "35", "procurement");
  const old = toolCollection("tool-tracking", "36", "master-data");
  const oldScope = toolCollection("tool-tracking", "36", "scope");
  const oldPrice = toolCollection("tool-tracking", "36", "procurement");
  const sourceUsage = toolUsageCollection("37", "master-data");
  const sourcePrice = toolUsageCollection("37", "procurement");
  const targetUsage = toolUsageCollection("38", "master-data");
  const targetPrice = toolUsageCollection("38", "procurement");
  const areas = [
    master,
    price,
    second,
    secondPrice,
    old,
    oldScope,
    oldPrice,
    sourceUsage,
    sourcePrice,
    targetUsage,
    targetPrice,
  ];
  const tenant = await protectedTenant(areas, (area) => {
    if (area === oldPrice || area === sourcePrice) return [];
    if (options.denySecond && area === second) return ["read"];
    if (options.denyTarget && area === targetUsage) return ["read"];
    return [...ACTIONS];
  });
  const firstTool = row("tools", {
    id: "100",
    custom_id: "73",
    brand: "Muster",
    category: "Bohrhammer",
    usage_cost_per_day: 23.125,
  });
  const secondTool = row("tools", {
    id: "101",
    custom_id: "74",
    brand: "Muster",
    category: "Rührwerk",
    usage_cost_per_day: 7.375,
  });
  for (const [area, source, active] of [
    [master, firstTool, "36"],
    [price, firstTool, null],
    [second, secondTool, null],
    [secondPrice, secondTool, null],
  ]) {
    await tenant.seed(
      area,
      area.prefix,
      toolPart("tool", area.scope.split(":")[1], area.facet, [source], active),
    );
  }
  const tracking = row("tool_trackings", {
    id: "102",
    tool_id: "100",
    project_id: "103",
    responsible_user_id: "1",
    started_by_user_id: "1",
    started_at: "2026-11-09T08:15:00Z",
    ended_at: null,
    tool_usage_cost_per_day: 17.375,
  });
  await tenant.seed(
    old,
    old.prefix,
    toolPart("tool-tracking", "36", "master-data", [tracking]),
  );
  await tenant.seed(oldPrice, oldPrice.prefix, {
    invalid: "Historical prices must not be opened",
  });
  await tenant.seed(sourcePrice, sourcePrice.prefix + "36", {
    invalid: "Source project prices must not be opened",
  });
  await tenant.seed(
    sourceUsage,
    sourceUsage.prefix + "36",
    toolUsagePart(tracking, "master-data"),
  );
  const transfer = row("tool_tracking_transfer_requests", {
    id: "105",
    tool_tracking_id: "102",
    status: "open",
    transfer_to_user_id: "1",
    created_by_user_id: "1",
    created_at: "2026-11-10T08:15:00Z",
  });
  await tenant.seed(
    oldScope,
    oldScope.prefix,
    toolPart("tool-tracking", "36", "scope", [transfer]),
  );
  const input = {
    operationId: "39",
    tools: [
      { id: "34", expectedTrackingId: "36" },
      { id: "35", expectedTrackingId: null },
    ],
    data: {
      projectId: "38",
      responsibleUserId: "1",
      comment: "Geheime Ausgabe Nordflügel",
    },
  };
  const account = unlockedAccount();
  const targets = await toolBookingTargets(
    account.dataKey,
    account.tenant,
    "user:1",
    toolBookingInput(input),
  );
  for (const target of targets) {
    for (const facet of CREATION_FACETS["tool-tracking"]) {
      await tenant.addArea(
        toolCollection("tool-tracking", target.trackingId, facet),
      );
    }
  }
  const store = createProtectedTools(
    tenant.client,
    new AbortController().signal,
    async () => ({
      async references(id) {
        expect(id).toBe("38");
        return {
          project: { finishedAt: null },
          head: { domain: targetUsage.domain, sequence: "0" },
        };
      },
    }),
    duckDriver,
  );
  const receiptId = immutableObject(
    "tool-tracking:39",
    "master-data",
    "tool-booking",
    "39",
  );
  return {
    tenant,
    store,
    input,
    targets,
    master,
    second,
    old,
    oldScope,
    oldPrice,
    sourceUsage,
    sourcePrice,
    targetUsage,
    targetPrice,
    receiptId,
  };
}

test("a mixed batch ends old bookings, denies transfers and creates every booking and project projection atomically", async () => {
  const f = await fixture();
  try {
    f.tenant.calls.length = 0;
    const output = await f.store.mutate("tools.trackMany", f.input);
    expect(output.trackings).toEqual(f.targets);
    const commits = f.tenant.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(commits).toHaveLength(1);
    const objects = commits[0].input.objects.map(
      (packet) => packet.envelope.object,
    );
    expect(objects).toContain(f.receiptId);
    expect(objects).toContain(f.sourceUsage.prefix + "36");
    const closed = await f.tenant.plain(f.old, f.old.prefix);
    expect(closed.rows[0].values.ended_at).not.toBeNull();
    expect(closed.rows[0].values.ended_by_user_id).toBe("1");
    const transfers = await f.tenant.plain(f.oldScope, f.oldScope.prefix);
    expect(transfers.rows[0].values.status).toBe("denied");
    const source = await f.tenant.plain(
      f.sourceUsage,
      f.sourceUsage.prefix + "36",
    );
    expect(source.tracking.values.ended_at).toBe(
      closed.rows[0].values.ended_at,
    );
    for (const [index, target] of output.trackings.entries()) {
      const booking = toolBookingArea(target.toolId);
      expect((await f.tenant.plain(booking, booking.prefix)).trackingId).toBe(
        target.trackingId,
      );
      const usage = await f.tenant.plain(
        f.targetUsage,
        f.targetUsage.prefix + target.trackingId,
      );
      expect(usage.tracking.values.project_id).toBe("104");
      const prices = await f.tenant.plain(
        f.targetPrice,
        f.targetPrice.prefix + target.trackingId,
      );
      expect(prices.tracking.values.tool_usage_cost_per_day).toBe(
        index === 0 ? 23.125 : 7.375,
      );
      const area = toolCollection(
        "tool-tracking",
        target.trackingId,
        "master-data",
      );
      const tracking = await f.tenant.plain(area, area.prefix);
      expect(tracking.rows[0].values.continuation_of).toBe(
        index === 0 ? "102" : null,
      );
    }
    const reads = f.tenant.calls.filter(
      (call) =>
        call.path === "zerotrust.objects.pages" ||
        call.path === "zerotrust.objects.list",
    );
    for (const call of reads) {
      for (const request of call.input.selections ?? [call.input]) {
        expect([f.oldPrice.domain, f.sourcePrice.domain]).not.toContain(
          request.domain,
        );
      }
    }
    expect(JSON.stringify(f.tenant.calls)).not.toContain(
      "Geheime Ausgabe Nordflügel",
    );
  } finally {
    f.store.close();
  }
});

for (const option of ["denySecond", "denyTarget"]) {
  test(`a batch with ${option} keeps all prior bookings and the complete selection unchanged`, async () => {
    const f = await fixture({ [option]: true });
    const before = structuredClone([...f.tenant.objects]);
    try {
      await expect(
        f.store.mutate("tools.trackMany", f.input),
      ).rejects.toThrow();
      expect([...f.tenant.objects]).toEqual(before);
      expect(
        f.tenant.calls.filter(
          (call) => call.path === "zerotrust.objects.batch",
        ),
      ).toHaveLength(0);
    } finally {
      f.store.close();
    }
  });
}

test("stale selection and a competing commit cannot end an earlier booking or partially publish its peers", async () => {
  const f = await fixture();
  try {
    const before = structuredClone([...f.tenant.objects]);
    await expect(
      f.store.mutate("tools.trackMany", {
        ...f.input,
        tools: [{ id: "34", expectedTrackingId: null }, f.input.tools[1]],
      }),
    ).rejects.toBeInstanceOf(ProtectedWriteConflict);
    expect([...f.tenant.objects]).toEqual(before);
    f.tenant.state.beforeCommit = async () => {
      f.tenant.state.beforeCommit = async () => {};
      f.tenant.domains.get(f.second.domain).head++;
    };
    await expect(f.store.mutate("tools.trackMany", f.input)).rejects.toThrow();
    expect([...f.tenant.objects]).toEqual(before);
  } finally {
    f.store.close();
  }
});

test("a durable receipt resolves a lost reply and an exact retry after return without creating another booking", async () => {
  const f = await fixture();
  try {
    f.tenant.state.loseReply = true;
    const output = await f.store.mutate("tools.trackMany", f.input);
    f.tenant.state.loseReply = false;
    await f.store.mutate("tools.untrack", { id: "34" });
    const before = structuredClone([...f.tenant.objects]);
    expect(
      await f.store.mutate("tools.trackMany", {
        ...f.input,
        tools: [...f.input.tools].reverse(),
      }),
    ).toEqual(output);
    expect([...f.tenant.objects]).toEqual(before);
    await expect(
      f.store.mutate("tools.trackMany", {
        ...f.input,
        data: { ...f.input.data, comment: "Different intent" },
      }),
    ).rejects.toThrow();
    expect([...f.tenant.objects]).toEqual(before);
    const receipt = await f.tenant.plain(
      toolCollection("tool-tracking", "39", "master-data"),
      f.receiptId,
    );
    expect(receipt.requestHash).not.toBeNull();
    expect(receipt.author).toBe("user:1");
    expect(
      f.receiptId.startsWith(
        immutablePrefix("tool-tracking:39", "master-data", "tool-booking"),
      ),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});

test("an uncommitted successful reply cannot acknowledge a batch", async () => {
  const f = await fixture();
  try {
    const before = structuredClone([...f.tenant.objects]);
    f.tenant.state.discardCommit = true;
    await expect(f.store.mutate("tools.trackMany", f.input)).rejects.toThrow();
    expect([...f.tenant.objects]).toEqual(before);
    f.tenant.state.discardCommit = false;
    await f.store.mutate("tools.trackMany", f.input);
    const booking = toolBookingArea("34");
    expect((await f.tenant.plain(booking, booking.prefix)).trackingId).toBe(
      "39",
    );
  } finally {
    f.store.close();
  }
});

test("a signed receipt with the right private input fingerprint still cannot substitute different output bookings", async () => {
  const f = await fixture();
  try {
    const account = unlockedAccount();
    const anchor = toolCollection(
      "tool-tracking",
      f.input.operationId,
      "master-data",
    );
    await f.tenant.seed(anchor, f.receiptId, {
      format: "sortsys-tool-booking-receipt-v1",
      operationId: f.input.operationId,
      author: "user:1",
      requestHash: await accountRequestFingerprint(
        account.dataKey,
        "sortsys/tool-booking-request/v1",
        account.tenant,
        "user:1",
        toolBookingInput(f.input),
      ),
      createdAt: new Date().toISOString(),
      trackings: [
        { toolId: "35", trackingId: f.targets[0].trackingId },
        { toolId: "34", trackingId: f.targets[1].trackingId },
      ],
    });
    const before = structuredClone([...f.tenant.objects]);
    await expect(f.store.mutate("tools.trackMany", f.input)).rejects.toThrow();
    expect([...f.tenant.objects]).toEqual(before);
  } finally {
    f.store.close();
  }
});

test("invalid, duplicate and ambiguous selections are rejected before any network request", () => {
  const input = {
    operationId: "39",
    tools: [{ id: "34", expectedTrackingId: null }],
    data: {},
  };
  for (const tools of [
    [],
    [...input.tools, ...input.tools],
    [{ id: "34" }],
    [{ id: "034", expectedTrackingId: null }],
    [{ id: "34", expectedTrackingId: "invalid!" }],
  ]) {
    expect(() => toolBookingInput({ ...input, tools })).toThrow();
  }
  expect(() => toolBookingInput({ ...input, extra: true })).toThrow();
});

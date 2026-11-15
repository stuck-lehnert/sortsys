import { afterEach, expect, test } from "bun:test";
import { compilePolicy, signPolicy } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import {
  COMMON_COST_COLLECTION,
  COMMON_COST_MODEL,
  COMMON_COST_SAVE,
  commonCostInstant,
  commonCostObject,
  commonCostPayload,
  commonCostsAt,
  wireCommonCosts,
} from "./commonCostData";
import { createProtectedCommonCosts } from "./commonCosts";
import { effectiveHistory } from "./effectiveHistory";
import { copyCommonCosts } from "./migrateCommonCosts";
import { row } from "./rowCodec.test.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { timestampMicros } from "./timestamps";

afterEach(() => lockCryptoSession());

function costRow(
  id,
  type = "mgk",
  effectiveAt = "2026-01-01T00:00:00.000001Z",
  relative = 0.2,
) {
  return row("global_common_cost_entries", {
    id,
    type,
    effective_at: effectiveAt,
    relative_factor: relative,
    constant: 12.5,
    created_by_user_id: "2",
    created_at: "2025-01-01T00:00:00Z",
    modified_at: "2025-02-01T00:00:00Z",
  });
}

function input(
  type = "mgk",
  effectiveAt = "2026-01-01",
  relativeFactor = 0.375,
) {
  return { type, effectiveAt, relativeFactor, constant: 11.125 };
}

async function fixture(actions, backup = false) {
  const tenant = await protectedTenant([COMMON_COST_COLLECTION], actions, {
    backup,
  });
  const controller = new AbortController();
  const store = createProtectedCommonCosts(
    tenant.client,
    controller.signal,
    duckDriver,
  );
  async function seed(source) {
    const id = commonCostObject(source.values.id);
    await tenant.seed(COMMON_COST_COLLECTION, id, {
      format: "sortsys-common-costs-v1",
      row: source,
    });
  }
  return { ...tenant, controller, store, seedCost: seed };
}

test("effective histories select exact instants and numeric IDs without depending on iteration order", () => {
  const entries = [
    {
      group: "a",
      instant: 10000000000000001n,
      id: 9007199254740993n,
      value: "first",
    },
    {
      group: "a",
      instant: 10000000000000001n,
      id: 9007199254740994n,
      value: "tie winner",
    },
    { group: "a", instant: 10000000000000002n, id: 1n, value: "later" },
    { group: "b", instant: 10000000000000003n, id: 9n, value: "future late" },
    {
      group: "b",
      instant: 10000000000000002n,
      id: 8n,
      value: "future earliest",
    },
  ];
  for (const source of [entries, [...entries].reverse()]) {
    expect([...effectiveHistory(source, 10000000000000001n)]).toEqual([
      ["a", "tie winner"],
    ]);
    expect(
      effectiveHistory(source, 10000000000000001n, "earliest").get("b"),
    ).toBe("future earliest");
  }
  expect(effectiveHistory(entries, 10000000000000002n).get("a")).toBe("later");
  expect(entries[0].value).toBe("first");
});

test("cost models bind object IDs and typed fields; UTC keys preserve all microseconds", () => {
  const source = costRow("9223372036854775807");
  const id = commonCostObject(source.values.id);
  const payload = { format: "sortsys-common-costs-v1", row: source };
  expect(commonCostPayload(payload, id).row.values.id).toBe(source.values.id);
  const invalidRows = [
    row("users"),
    costRow("0"),
    costRow("1", "other"),
    costRow("1", "fgk", undefined, -0.1),
    { ...source, values: { ...source.values, constant: Infinity } },
    { ...source, values: { ...source.values, arbitrary: "field" } },
  ];
  for (const invalid of invalidRows) {
    expect(() => commonCostPayload({ ...payload, row: invalid }, id)).toThrow();
  }
  expect(() => commonCostPayload(payload, commonCostObject("2"))).toThrow();
  expect(() =>
    COMMON_COST_MODEL.decode(payload, id, {
      ...COMMON_COST_COLLECTION,
      facet: "master-data",
    }),
  ).toThrow();
  expect(commonCostInstant("2026-01-01")).toBe("2026-01-01T00:00:00.000000Z");
  expect(commonCostInstant("2026-01-01T01:00:00.123456+01:00")).toBe(
    "2026-01-01T00:00:00.123456Z",
  );
  for (const date of ["2026-02-30", "2026-01-01T10:00:00", new Date(NaN)]) {
    expect(() => commonCostInstant(date)).toThrow();
  }
});

test("active common costs retain historical cutoffs and do not take a future default", () => {
  const rows = [
    costRow("1", "mgk", "2026-01-01T00:00:00.000001Z", 0.1),
    costRow("2", "mgk", "2026-01-01T01:00:00.000002+01:00", 0.2),
    costRow("3", "fgk", "2027-01-01T00:00:00Z", 0.3),
  ];
  expect(
    commonCostsAt(rows, timestampMicros("2026-01-01T00:00:00.000001Z")).get(
      "mgk",
    ).values.id,
  ).toBe("1");
  const settings = wireCommonCosts(rows, new Date("2026-06-01"));
  expect(settings.mgk.relativeFactor).toBe(0.2);
  expect(settings.productOverheadFactor).toBe(1.2);
  expect(settings.specialRecordOverheadFactor).toBe(1.2);
  expect(settings.fgk).toEqual({
    type: "fgk",
    effectiveAt: new Date(0),
    relativeFactor: 0,
    constant: 0,
  });
  expect(settings.history.map((entry) => entry.id)).toEqual(["3", "2", "1"]);
  expect(settings.toolOverheadFactor).toBe(1);
});

test("create, upsert, delete and recreation retain source identity and keep costs off the wire", async () => {
  const f = await fixture();
  try {
    await f.seedCost(costRow("70", "mgk", "2026-01-01T00:00:00.123456Z"));
    await f.store.mutate(
      "settings.costs.set",
      input("mgk", "2026-01-01T01:00:00.123456+01:00"),
    );
    const settings = await f.store.query("settings.costs.get");
    expect(settings.history).toHaveLength(1);
    expect(settings.history[0]).toMatchObject({
      id: BigInt(70).toString(32),
      relativeFactor: 0.375,
      constant: 11.125,
      createdByUserId: "1",
      createdAt: new Date("2025-01-01"),
    });
    const saved = await f.plain(COMMON_COST_COLLECTION, commonCostObject("70"));
    expect(saved.row.values.effective_at).toBe("2026-01-01T00:00:00.123456Z");
    await f.store.mutate("settings.costs.delete", {
      type: "mgk",
      effectiveAt: "2026-01-01T00:00:00.123456Z",
    });
    expect((await f.store.query("settings.costs.get")).history).toEqual([]);
    await f.store.mutate(
      "settings.costs.set",
      input("mgk", "2026-01-01T00:00:00.123456Z"),
    );
    expect((await f.store.query("settings.costs.get")).history).toHaveLength(1);
    const calls = JSON.stringify(f.calls);
    expect(calls).not.toContain("relative_factor");
    expect(calls).not.toContain("11.125");
    expect(
      f.calls.some((call) => call.path.startsWith("settings.costs.")),
    ).toBe(false);
  } finally {
    f.store.close();
  }
}, 30000);

test("the form saves three rates atomically and legacy factors update two rates in one publication", async () => {
  const f = await fixture();
  try {
    await f.store.mutate(COMMON_COST_SAVE, [
      input("fgk"),
      input("mgk"),
      input("ngk"),
    ]);
    let batches = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(batches).toHaveLength(1);
    expect(batches[0].input.objects).toHaveLength(3);
    await f.store.mutate("settings.costs.update", {
      workHourOverheadFactor: 1.25,
      productOverheadFactor: 1.5,
      specialRecordOverheadFactor: 1.3,
      toolOverheadFactor: 99,
    });
    batches = f.calls.filter((call) => call.path === "zerotrust.objects.batch");
    expect(batches).toHaveLength(2);
    expect(batches[1].input.objects).toHaveLength(2);
    const settings = await f.store.query("settings.costs.get");
    expect(settings.fgk.relativeFactor).toBe(0.25);
    expect(settings.mgk.relativeFactor).toBeCloseTo(0.4);
    expect(settings.toolOverheadFactor).toBe(1);
  } finally {
    f.store.close();
  }
}, 30000);

test("invalid input never publishes any part of a multi-rate save", async () => {
  const f = await fixture();
  try {
    const invalid = [
      [input("mgk"), input("mgk")],
      [input("fgk"), input("ngk", "2026-02-30")],
      [input("fgk"), input("ngk", "2026-01-01", -1)],
      [input("fgk"), { ...input("mgk"), constant: NaN }],
      [],
    ];
    for (const values of invalid)
      await expect(f.store.mutate(COMMON_COST_SAVE, values)).rejects.toThrow();
    await expect(
      f.store.query("settings.costs.get", { userId: "2" }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("settings.costs.update", { arbitrary: 1 }),
    ).rejects.toThrow();
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(0);
    expect((await f.store.query("settings.costs.get")).history).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("create, update and delete permissions remain independent, including an administrator", async () => {
  const f = await fixture(() => ["read", "update"]);
  f.state.roles = [":admin"];
  try {
    await f.seedCost(costRow("1", "mgk", "2026-01-01T00:00:00Z"));
    await f.store.mutate("settings.costs.set", input());
    await expect(
      f.store.mutate("settings.costs.set", input("fgk")),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("settings.costs.delete", {
        type: "mgk",
        effectiveAt: "2026-01-01",
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate(COMMON_COST_SAVE, [
        input("mgk", "2026-01-01", 0.9),
        input("fgk"),
      ]),
    ).rejects.toThrow();
    expect(
      (await f.store.query("settings.costs.get")).history[0].relativeFactor,
    ).toBe(0.375);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test("read denial is an error rather than an empty zero-cost history; read-only grants never write", async () => {
  const f = await fixture(() => ["read"]);
  try {
    await f.seedCost(costRow("1"));
    expect((await f.store.query("settings.costs.get")).history).toHaveLength(1);
    await expect(
      f.store.mutate("settings.costs.set", input()),
    ).rejects.toThrow();
    const original = f.client.query;
    const policy = (await original("zerotrust.policy.get"))[0];
    const { signature, ...unsigned } = policy;
    const denied = await signPolicy(
      { ...unsigned, version: "3", rules: [] },
      f.authorityKey.privateKey,
    );
    const { signature: ignored, ...permissions } = denied;
    expect(
      compilePolicy(permissions, ["user:1"]).allows(
        "organization",
        "calculation",
        "read",
      ),
    ).toBe(false);
    f.client.query = (path, ...args) =>
      path === "zerotrust.policy.get"
        ? Promise.resolve([denied, null])
        : original(path, ...args);
    await f.store.refresh();
    await expect(f.store.query("settings.costs.get")).rejects.toThrow();
  } finally {
    f.store.close();
  }
});

test("independent runtimes retry an actual head conflict without losing another rate", async () => {
  const f = await fixture();
  const peer = createProtectedCommonCosts(
    { ...f.client },
    new AbortController().signal,
    duckDriver,
  );
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  let attempts = 0;
  f.state.beforeCommit = async () => {
    attempts++;
    if (attempts === 2) release();
    if (attempts <= 2) await barrier;
  };
  try {
    await Promise.all([
      f.store.mutate("settings.costs.set", input("mgk")),
      peer.mutate("settings.costs.set", input("fgk")),
    ]);
    await f.store.refresh();
    expect(
      (await f.store.query("settings.costs.get")).history.map(
        (entry) => entry.type,
      ),
    ).toEqual(["fgk", "mgk"]);
    expect(attempts).toBeGreaterThanOrEqual(3);
  } finally {
    release();
    peer.close();
    f.store.close();
  }
}, 30000);

test("lost replies are read back; false replies do not confirm any rate", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;
    await f.store.mutate(COMMON_COST_SAVE, [
      input("fgk"),
      input("mgk"),
      input("ngk"),
    ]);
    f.state.loseReply = false;
    f.state.discardCommit = true;
    await expect(
      f.store.mutate(COMMON_COST_SAVE, [
        input("fgk", "2026-01-01", 0.9),
        input("mgk", "2026-01-01", 0.9),
      ]),
    ).rejects.toThrow();
    expect(
      (await f.store.query("settings.costs.get")).history.map(
        (entry) => entry.relativeFactor,
      ),
    ).toEqual([0.375, 0.375, 0.375]);
  } finally {
    f.state.discardCommit = false;
    f.store.close();
  }
}, 30000);

test("source conversion repeats exactly and rejects extra or changed destinations", async () => {
  const f = await fixture(undefined, true);
  try {
    const rows = [costRow("9223372036854775807"), costRow("2", "fgk")];
    await copyCommonCosts(f.client, rows, f.controller.signal);
    const batches = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    await copyCommonCosts(f.client, [...rows].reverse(), f.controller.signal);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(batches);
    const settings = await f.store.query("settings.costs.get");
    expect(
      settings.history.find((entry) => entry.type === "mgk"),
    ).toMatchObject({
      id: "7vvvvvvvvvvvv",
      createdByUserId: "2",
      createdAt: new Date("2025-01-01"),
    });
    await expect(
      copyCommonCosts(
        f.client,
        [costRow("3"), costRow("4")],
        f.controller.signal,
      ),
    ).rejects.toThrow();
    await expect(
      copyCommonCosts(f.client, [costRow("3")], f.controller.signal),
    ).rejects.toThrow();
    await f.store.mutate("settings.costs.set", input("ngk"));
    await expect(
      copyCommonCosts(f.client, rows, f.controller.signal),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, 30000);

test("the facade integrates queries and the form's atomic save without a plaintext cost call", async () => {
  const f = await fixture();
  const app = createBusinessClient(f.client, { productDriver: duckDriver });
  try {
    await app.commonCosts.save([input("fgk"), input("mgk"), input("ngk")]);
    const [settings, error] = await app.query("settings.costs.get", undefined);
    expect(error).toBeNull();
    expect(settings.history).toHaveLength(3);
    expect(
      (await app.mutate("settings.costs.set", input("fgk", "2025-01-01")))[1],
    ).toBeNull();
    expect(
      f.calls.some((call) => call.path.startsWith("settings.costs.")),
    ).toBe(false);
  } finally {
    app.dispose();
    f.store.close();
  }
});

test("cancellation and account locking reject work using the old context", async () => {
  const f = await fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      f.store.mutate("settings.costs.set", input(), cancelled.signal),
    ).rejects.toThrow();
    await f.store.query("settings.costs.get");
    await lockCryptoSession();
    await expect(f.store.query("settings.costs.get")).rejects.toThrow();
    await expect(
      f.store.mutate("settings.costs.set", input()),
    ).rejects.toThrow();
    expect(
      f.calls.some((call) => call.path === "zerotrust.objects.batch"),
    ).toBe(false);
  } finally {
    f.store.close();
  }
});

import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { row } from "./rowCodec.test.mjs";
import { regieFixture } from "./regieReportData.test.mjs";
import { regieCollection } from "./regieReportData";
import { createProtectedRegieReports } from "./regieReports";
import { projectCollection } from "./projectData";
import { PRICE_COLLECTION, PRODUCT_COLLECTION, publicId } from "./products";
import { personnelCollection, personnelPart } from "./personnelData";
import { createBusinessDatabase } from "./database";
import { projectCompleteRows } from "./projection";
import { prepareRegieReports } from "./migrateRegieReports";
import { createBusinessClient } from "./businessClient";

afterEach(() => lockCryptoSession());
const ALL = ["read", "create", "update", "delete"];
async function fixture({ hours = ALL, material = ALL, prices = ALL } = {}) {
  const area = regieCollection("2"),
    timeArea = regieCollection("2", true),
    project = projectCollection("2"),
    person = personnelCollection("7", "master-data");
  const f = await protectedTenant(
    [area, timeArea, project, person, PRODUCT_COLLECTION, PRICE_COLLECTION],
    (a) =>
      a.domain === area.domain
        ? material
        : a.domain === timeArea.domain
          ? hours
          : a.domain === PRICE_COLLECTION.domain
            ? prices
            : ALL,
  );
  const source = regieFixture();
  await f.seed(area, area.prefix + "3", source.value);
  await f.seed(timeArea, timeArea.prefix + "3", source.hours);
  await f.seed(project, project.prefix, {
    format: "sortsys-project-v1",
    project: row("projects", { id: "2", title: "Fenstersanierung" }),
    contacts: [],
  });
  await f.seed(
    person,
    person.prefix,
    personnelPart(
      row("users", {
        id: "7",
        username: "maria",
        first_name: "Maria",
        contract_type: "internal",
        ui_locale: "de",
      }),
      "master-data",
    ),
  );
  await f.seed(PRODUCT_COLLECTION, "product:6", {
    format: "sortsys-product-v1",
    product: row("products", {
      id: "6",
      custom_id: "17",
      name: "Dichtmasse",
      base_unit: "kg",
      other_units: "{}",
    }),
    categories: [],
  });
  await f.seed(PRICE_COLLECTION, "product-price:9", {
    format: "sortsys-product-price-v1",
    price: row("product_price_records", {
      id: "9",
      product_id: "6",
      timestamp: "2026-08-26T12:00:00.123456Z",
      price: 23.456789,
    }),
  });
  return {
    ...f,
    area,
    timeArea,
    source,
    store: createProtectedRegieReports(
      f.client,
      new AbortController().signal,
      duckDriver,
    ),
  };
}
test("regie material edits neither read nor replace hidden hours or prices", async () => {
  const f = await fixture({ hours: [], prices: [] });
  try {
    const hours = f.objects.get(f.timeArea.prefix + "3"),
      before = await f.store.query("regieReports.get", { id: "3" });
    expect(before.workHoursAvailable).toBe(false);
    expect(before.workHours).toEqual([]);
    expect(before.hoursRevision).toBeUndefined();
    await f.store.mutate("regieReports.update", {
      id: "3",
      expectedRevision: before.revision,
      data: {
        summary: "Private Zusatzleistung 163728",
        products: [{ id: "4", productId: "6", quantity: 3.125 }],
      },
    });
    const saved = await f.store.query("regieReports.get", { id: "3" });
    expect(saved.products[0]).toMatchObject({
      id: "4",
      quantity: 3.125,
      comment: "Sonderfarbe",
    });
    expect(f.objects.get(f.timeArea.prefix + "3")).toEqual(hours);
    expect(
      f.calls
        .filter((call) => isKeyEnvelopeQuery(call.path))
        .some(
          (call) =>
            call.input.domain === f.timeArea.domain ||
            call.input.domain === PRICE_COLLECTION.domain,
        ),
    ).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain(
      "Private Zusatzleistung 163728",
    );
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: { workHours: [] },
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: { day: "2026-08-31" },
      }),
    ).rejects.toThrow();
    await expect(
      f.store.query("regieReports.costs.get", { id: "3" }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("hour-only writers preserve material and publish protected time changes with a guard", async () => {
  const f = await fixture({ material: ["read"] });
  try {
    const before = f.objects.get(f.area.prefix + "3"),
      report = await f.store.query("regieReports.get", { id: "3" });
    await f.store.mutate("regieReports.update", {
      id: "3",
      expectedRevision: report.revision,
      expectedHoursRevision: report.hoursRevision,
      data: {
        workHours: [{ id: "8", userId: null, day: "2026-08-26", hours: 8.125 }],
      },
    });
    const saved = await f.store.query("regieReports.get", { id: "3" });
    expect(saved.workHours[0]).toMatchObject({ id: "8", hours: 8.125 });
    expect(f.objects.get(f.area.prefix + "3")).toEqual(before);
    const commit = f.calls.find(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(commit.input.objects.map((packet) => packet.domain)).toEqual([
      f.timeArea.domain,
    ]);
    expect(commit.input.heads.map((head) => head.domain)).toContain(
      f.area.domain,
    );
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: { summary: "Forbidden" },
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("date and hour changes are atomic, validate the week and survive a lost acknowledgement", async () => {
  const f = await fixture();
  try {
    const before = await f.store.query("regieReports.get", { id: "3" });
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: { day: "2026-08-31" },
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: {
          day: "2026-08-31",
          workHours: [{ id: "8", day: "2026-08-25", hours: 2 }],
        },
      }),
    ).rejects.toThrow();
    f.state.loseReply = true;
    await f.store.mutate("regieReports.update", {
      id: "3",
      expectedRevision: before.revision,
      expectedHoursRevision: before.hoursRevision,
      data: {
        day: "2026-09-02T00:00:00.000+02:00",
        workHours: [{ id: "8", day: "2026-09-01", hours: 2.375 }],
      },
    });
    const saved = await f.store.query("regieReports.get", { id: "3" });
    expect(saved.day.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(saved.workHours[0].id).toBe("8");
    const commit = f.calls.find(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(
      new Set(commit.input.objects.map((packet) => packet.domain)).size,
    ).toBe(2);
    f.state.loseReply = false;
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        expectedRevision: before.revision,
        data: { summary: "Stale" },
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("regie creation validates encrypted references, filters dates and keeps project-relative numbering", async () => {
  const f = await fixture();
  try {
    await expect(
      f.store.mutate("regieReports.create", {
        projectId: "2",
        day: "2026-08-25",
        products: [{ productId: "a", quantity: 1 }],
      }),
    ).rejects.toThrow();
    const created = await f.store.mutate("regieReports.create", {
      projectId: "2",
      day: "2026-08-18",
      products: [{ productId: "6", quantity: 3.125 }],
      workHours: [{ userId: "7", day: "2026-08-19", hours: 4.375 }],
    });
    const first = await f.store.query("regieReports.get", { id: created.id }),
      second = await f.store.query("regieReports.get", { id: "3" });
    expect(first.autoId).toBe(1);
    expect(second.autoId).toBe(2);
    expect(first.workHours[0]).toMatchObject({ userId: "7", hours: 4.375 });
    expect(
      (
        await f.store.query("regieReports.list", {
          projectId: "2",
          dayFrom: "2026-08-20",
          dayTo: "2026-08-30",
        })
      ).map((item) => item.id),
    ).toEqual(["3"]);
    await f.store.mutate("regieReports.delete", { id: created.id });
    await expect(
      f.store.query("regieReports.get", { id: created.id }),
    ).rejects.toThrow();
    expect((await f.store.query("regieReports.get", { id: "3" })).autoId).toBe(
      1,
    );
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("material costs open only authorized price records and retain exact historic amounts", async () => {
  const f = await fixture();
  try {
    const value = await f.store.query("regieReports.costs.get", { id: "3" });
    expect(value.totalCost).toBe(2.375 * 23.456789);
    expect(value.products[0].priceRecord.id).toBe("9");
    expect(JSON.stringify(f.calls)).not.toContain("23.456789");
    expect(value.workHours[0].hours).toBe(7.375);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("a concurrent material change prevents publication of dependent working time", async () => {
  const f = await fixture();
  try {
    const previous = f.objects.get(f.timeArea.prefix + "3");
    f.state.beforeCommit = async () => {
      f.state.beforeCommit = async () => {};
      await f.seed(f.area, f.area.prefix + "3", {
        ...f.source.value,
        report: {
          ...f.source.value.report,
          values: { ...f.source.value.report.values, summary: "Peer" },
        },
      });
    };
    await expect(
      f.store.mutate("regieReports.update", {
        id: "3",
        data: { workHours: [{ id: "8", day: "2026-08-25", hours: 1 }] },
      }),
    ).rejects.toThrow();
    expect(f.objects.get(f.timeArea.prefix + "3")).toEqual(previous);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("a creation retry after losing both acknowledgement and readback keeps one stable report ID", async () => {
  const f = await fixture(),
    query = f.client.query,
    input = {
      operationId: "a",
      projectId: "2",
      day: "2026-08-25",
      summary: "Idempotent private intent",
      specialRecords: [{ name: "Transport", unit: "Stk", amount: 1.125 }],
      workHours: [{ userId: null, day: "2026-08-26", hours: 2.375 }],
    };
  let unreadable = true;
  f.client.query = async (path, value) =>
    path === "zerotrust.objects.get" && unreadable
      ? [null, new Error("Readback unavailable")]
      : query(path, value);
  try {
    f.state.loseReply = true;
    await expect(
      f.store.mutate("regieReports.create", input),
    ).rejects.toThrow();
    unreadable = false;
    f.state.loseReply = false;
    const committed = f.objects.get(f.area.prefix + "a"),
      hours = f.objects.get(f.timeArea.prefix + "a");
    expect(committed).toBeDefined();
    expect(hours).toBeDefined();
    expect(await f.store.mutate("regieReports.create", input)).toEqual({
      id: "a",
    });
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(1);
    expect(f.objects.get(f.area.prefix + "a")).toEqual(committed);
    expect(f.objects.get(f.timeArea.prefix + "a")).toEqual(hours);
    await expect(
      f.store.mutate("regieReports.create", {
        ...input,
        summary: "Changed intent",
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("regieReports.list", { projectId: "2" })).filter(
        (row) => row.id === "a",
      ).length,
    ).toBe(1);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("regie conversion is repeatable and never places working times under the quantity key", async () => {
  const area = regieCollection("2"),
    hours = regieCollection("2", true),
    f = await protectedTenant([area, hours], undefined, { backup: true }),
    db = await createBusinessDatabase(await duckDriver()),
    source = regieFixture();
  try {
    await projectCompleteRows(db, [
      row("projects", { id: "2", title: "Fenster" }),
      row("products", {
        id: "6",
        custom_id: "17",
        name: "Dichtmasse",
        base_unit: "kg",
        other_units: "{}",
      }),
      source.value.report,
      ...source.value.products,
      ...source.value.specials,
      ...source.hours.hours,
    ]);
    await prepareRegieReports(
      f.client,
      db,
      "user:1",
      new AbortController().signal,
    );
    const main = await f.plain(area, area.prefix + "3"),
      times = await f.plain(hours, hours.prefix + "3");
    expect(main.hours).toBeUndefined();
    expect(times.hours[0].values.hours).toBe(7.375);
    const count = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    await prepareRegieReports(
      f.client,
      db,
      "user:1",
      new AbortController().signal,
    );
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(count);
  } finally {
    await db.close();
  }
}, fixtureTimeout(20000));
test("normal business-client calls and subscriptions never send a plaintext regie procedure", async () => {
  const f = await fixture(),
    client = createBusinessClient(f.client, { productDriver: duckDriver }),
    values = [];
  const sub = client
    .streamQuery("regieReports.get", { id: "3" })
    .subscribe(([value]) => {
      if (value) values.push(value);
    });
  const wait = async (predicate) => {
    const until = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > until)
        throw new Error("Regie subscription did not update");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    await wait(() => values.length);
    const [reply, error] = await client.mutate("regieReports.update", {
      id: "3",
      data: { summary: "Private subscription 574829" },
    });
    expect(error).toBeNull();
    expect(reply.success).toBe(true);
    await wait(() => values.at(-1).summary === "Private subscription 574829");
    expect(f.calls.some((call) => call.path.startsWith("regieReports."))).toBe(
      false,
    );
    expect(JSON.stringify(f.calls)).not.toContain(
      "Private subscription 574829",
    );
  } finally {
    sub.unsubscribe();
    client.dispose();
    f.store.close();
  }
}, fixtureTimeout(20000));

test("deleting a regie report uses only its read/delete grant and retains hidden working times and prices", async () => {
  const f = await fixture({
    material: ["read", "delete"],
    hours: [],
    prices: [],
  });
  try {
    const hours = f.objects.get(f.timeArea.prefix + "3");
    f.state.loseReply = true;
    expect(
      await f.store.mutate("regieReports.delete", {
        id: "3",
        expectedRevision: "1",
      }),
    ).toEqual({ success: true });
    expect(f.objects.get(f.area.prefix + "3").format).toBe(
      "sortsys-object-tombstone-v1",
    );
    expect(f.objects.get(f.timeArea.prefix + "3")).toEqual(hours);
    expect(
      await f.store.query("regieReports.list", { projectId: "2" }),
    ).toEqual([]);
    expect(
      f.calls
        .filter((call) => isKeyEnvelopeQuery(call.path))
        .every(
          (call) =>
            ![f.timeArea.domain, PRICE_COLLECTION.domain].includes(
              call.input.domain,
            ),
        ),
    ).toBe(true);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("date filters and pages preserve project numbering and numeric ID order", async () => {
  const f = await fixture();
  const day = "2026-08-31";
  try {
    for (const rowId of ["31", "32"]) {
      const report = row("regie_reports", { id: rowId, project_id: "2", day });
      const objectId = f.area.prefix + publicId(report.values.id);
      await f.seed(f.area, objectId, {
        ...f.source.value,
        report,
        products: [],
        specials: [],
      });
    }

    const input = { projectId: "2", dayFrom: day, dayTo: day, limit: 1 };
    const list = (offset) =>
      f.store.query("regieReports.list", { ...input, offset });
    const first = await list(0);
    const second = await list(1);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: publicId("32"), autoId: 3 });
    expect(second[0]).toMatchObject({ id: publicId("31"), autoId: 2 });
    expect(first[0]).toEqual(
      await f.store.query("regieReports.get", { id: publicId("32") }),
    );
    expect(await list(2)).toEqual([]);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

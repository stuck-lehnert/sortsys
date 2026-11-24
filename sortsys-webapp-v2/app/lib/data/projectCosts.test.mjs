import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { row } from "./rowCodec.test.mjs";
import {
  createProtectedProjectCosts,
  projectCostRequests,
} from "./projectCosts";
import { calculateProjectCosts, costPeriod, projectCostRates } from "./projectCostCalculation";
import { indexHistoricalPrices } from "./historicalPrices";
import { createProtectedProjectFinance } from "./projectFinance";
import { financialObject, financialPayload } from "./projectFinancialData";
import { emptyProjectCommercial } from "./projectCommercial";
import { toolUsagePart } from "./projectToolUsage";
import { publicId } from "./products";
import { createBusinessClient } from "./businessClient";

afterEach(() => lockCryptoSession());

function calculateCosts(source, period) {
  const rates = projectCostRates(
    indexHistoricalPrices(source.productPrices),
    source.commonCosts,
  );
  return calculateProjectCosts(source, rates, period);
}

function sourceRows(project = "1") {
  const projectRow = row("projects", {
    id: project,
    title: `Fenstersanierung ${project}`,
  });
  const offer = row("project_financial_entries", {
    id: "10",
    project_id: project,
    type: "offer",
    amount: 1000,
    created_at: "2026-01-15T10:00:00Z",
  });
  const invoice = row("project_financial_entries", {
    id: "11",
    project_id: project,
    type: "invoice",
    amount: 250,
    created_at: "2026-02-05T10:00:00Z",
  });
  const note = row("product_delivery_notes", {
    id: "20",
    project_id: project,
    auto_id: "17",
    effective_timestamp: "2026-02-02T10:00:00.123456Z",
  });
  const record = row("product_delivery_records", {
    id: "30",
    note_id: "20",
    product_id: "1",
    quantity: 2,
    unit: "kg",
  });
  const special = row("product_delivery_special_records", {
    id: "31",
    note_id: "20",
    name: "Entsorgung",
    unit: "Stk",
    amount: 1.5,
    price_per_unit: null,
  });
  const report = row("daily_project_reports", {
    id: "35",
    project_id: project,
    day: "2026-02-02",
  });
  const hours = [
    ["40", "internal", 2, 20],
    ["41", "internal", 3, 10],
    ["42", "subcontractor", 1.5, 30],
    ["43", "external", 1.25, 8],
  ].map(([id, contract, quantity]) =>
    row("daily_project_report_work_hours", {
      id,
      report_id: "35",
      contract_type: contract,
      hours: quantity,
      cost_per_hour: null,
    }),
  );
  const costs = [
    { id: "18", costPerHour: 20 },
    { id: "19", costPerHour: 10 },
    { id: "1a", costPerHour: 30 },
    { id: "1b", costPerHour: 8 },
  ];
  const tracking = row("tool_trackings", {
    id: "90",
    tool_id: "91",
    project_id: project,
    tool_usage_cost_per_day: 2.5,
    started_at: "2026-02-01T23:30:00Z",
    ended_at: "2026-02-03T00:15:00Z",
  });
  const price = row("product_price_records", {
    id: "100",
    product_id: "1",
    timestamp: "2026-02-01T00:00:00Z",
    price: 10.25,
  });
  const commonCosts = [
    ["101", "fgk", 0.5, 2],
    ["102", "mgk", 0.2, 5],
    ["103", "ngk", 0.3, 7],
  ].map(([id, type, factor, constant]) =>
    row("global_common_cost_entries", {
      id,
      type,
      effective_at: "1970-01-01T00:00:00Z",
      relative_factor: factor,
      constant,
    }),
  );
  return {
    projectRow,
    source: {
      financial: [offer, invoice],
      productPrices: [price],
      commonCosts,
      tools: [tracking],
      deliveries: [
        {
          value: {
            format: "sortsys-delivery-note-v1",
            note,
            records: [record],
            specialRecords: [special],
          },
          prices: {
            format: "sortsys-delivery-prices-v1",
            projectId: project,
            noteId: "k",
            prices: [{ id: "v", pricePerUnit: 4.5 }],
          },
        },
      ],
      daily: [
        {
          value: {
            format: "sortsys-daily-report-v1",
            report,
            hours,
            photos: [],
          },
          costs: {
            format: "sortsys-daily-costs-v1",
            projectId: project,
            reportId: "13",
            costs,
          },
        },
      ],
    },
  };
}

async function fixture(actions, second = false) {
  const requests = projectCostRequests("1");
  const other = projectCostRequests("2");
  const areas = [
    ...new Map(
      [...requests.all, ...(second ? other.all : [])].map((request) => [
        request.area.domain,
        request.area,
      ]),
    ).values(),
  ];
  const tenant = await protectedTenant(areas, actions);
  const controller = new AbortController();
  const store = createProtectedProjectCosts(
    tenant.client,
    controller.signal,
    duckDriver,
  );
  const finance = createProtectedProjectFinance(
    tenant.client,
    controller.signal,
    duckDriver,
  );
  const values = sourceRows();
  async function seed(request, object, value) {
    await tenant.seed(request.area, object, value);
  }
  await seed(requests.project, requests.project.area.prefix, {
    format: "sortsys-project-v1",
    project: values.projectRow,
    contacts: [],
  });
  await seed(
    requests.workflow,
    requests.workflow.area.prefix + "register",
    emptyProjectCommercial("1", "offer-prices"),
  );
  for (const financial of values.source.financial) {
    const request =
      financial.values.type === "offer" ? requests.offers : requests.invoices;
    await seed(request, financialObject(financial), {
      format: "sortsys-project-financial-v1",
      row: financial,
      exactAmount: null,
    });
  }
  for (const { value, prices } of values.source.deliveries) {
    await seed(
      requests.deliveries,
      requests.deliveries.area.prefix + "k",
      value,
    );
    await seed(
      requests.specialPrices,
      requests.specialPrices.area.prefix + "k",
      prices,
    );
  }
  for (const { value, costs } of values.source.daily) {
    await seed(requests.daily, requests.daily.area.prefix + "13", value);
    await seed(
      requests.dailyCosts,
      requests.dailyCosts.area.prefix + "13",
      costs,
    );
  }
  for (const tracking of values.source.tools) {
    for (const request of [requests.tools, requests.toolPrices]) {
      await seed(
        request,
        request.area.prefix + publicId(tracking.values.id),
        toolUsagePart(tracking, request.area.facet),
      );
    }
  }
  for (const price of values.source.productPrices)
    await seed(
      requests.productPrices,
      "product-price:" + publicId(price.values.id),
      { format: "sortsys-product-price-v1", price },
    );
  for (const cost of values.source.commonCosts)
    await seed(
      requests.commonCosts,
      requests.commonCosts.area.prefix + publicId(cost.values.id),
      { format: "sortsys-common-costs-v1", row: cost },
    );
  if (second) {
    await seed(other.project, other.project.area.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", {
        id: "2",
        title: "Leerprojekt",
        finished_at: "2025-12-31T10:00:00Z",
      }),
      contacts: [],
    });
    await seed(
      other.workflow,
      other.workflow.area.prefix + "register",
      emptyProjectCommercial("2", "offer-prices"),
    );
  }
  return {
    ...tenant,
    store,
    finance,
    controller,
    requests,
    other,
    source: values.source,
  };
}

test("project costs use one material constant per note and one labour constant per category and day", () => {
  const cost = calculateCosts(sourceRows().source);
  expect(cost.totalCosts).toEqual({
    offers: 1000,
    invoices: 250,
    deliveryNotes: 27.25,
    products: 20.5,
    specialRecords: 6.75,
    workHours: 80,
    subcontractorWorkHours: 45,
    toolTrackings: 7.5,
    overall: 227.7,
  });
  expect(cost.commonCosts.fgk).toEqual({
    baseCost: 70,
    overheadCost: 37,
    totalCost: 107,
  });
  expect(cost.commonCosts.mgk.overheadCost).toBe(10.45);
  expect(cost.commonCosts.ngk.overheadCost).toBe(20.5);
  expect(cost.workHours.map((entry) => entry.contractType)).toEqual([
    "external",
    "internal",
    "internal",
  ]);
});

test("date filtering keeps whole overlapping tool durations and UTC calendar work days", () => {
  const source = sourceRows().source;
  const exact = calculateCosts(
    source,
    costPeriod("2026-02-02T12:00:00Z", "2026-02-02T13:00:00Z"),
  );
  expect(exact.deliveryNotes).toEqual([]);
  expect(exact.totalCosts.workHours).toBe(80);
  expect(exact.totalCosts.toolTrackings).toBe(7.5);
  expect(exact.offers).toEqual([]);
  expect(exact.invoices).toEqual([]);
  const offset = calculateCosts(
    source,
    costPeriod("2026-02-03T00:30:00+02:00", "2026-02-03T01:00:00+02:00"),
  );
  expect(offset.workHours).toHaveLength(3);
  expect(() => costPeriod("2026-02-02", null)).toThrow();
  expect(() =>
    costPeriod("2026-02-03T00:00:00Z", "2026-02-02T00:00:00Z"),
  ).toThrow();
});

test("cost row order uses microseconds, then numeric identifiers for the same instant", () => {
  const source = sourceRows().source;
  const details = [
    ["9", "2026-02-02T10:00:00.123456Z"],
    ["100", "2026-02-02T10:00:00.123455Z"],
    ["10", "2026-02-02T11:00:00.123456+01:00"],
  ];
  const ids = ["10", "9", "100"].map(publicId);
  const result = calculateCosts({
    ...source,
    financial: details.map(([id, created_at]) =>
      row("project_financial_entries", {
        id, created_at, project_id: "1", type: "invoice", amount: 10,
      }),
    ),
    deliveries: details.map(([id, effective_timestamp]) => ({
      value: {
        ...source.deliveries[0].value,
        note: row("product_delivery_notes", { id, effective_timestamp, project_id: "1" }),
        records: [],
        specialRecords: [],
      },
    })),
    tools: details.map(([id, started_at]) =>
      row("tool_trackings", { ...source.tools[0].values, id, started_at }),
    ),
  });

  expect(result.invoices.map(({ id }) => id)).toEqual(ids);
  expect(result.deliveryNotes.map(({ noteId }) => noteId)).toEqual(ids);
  expect(result.toolTrackings.map(({ id }) => id)).toEqual(ids);
});

test("historical price lookup retains microseconds, tie IDs and the earliest future fallback", () => {
  const source = sourceRows().source;
  source.productPrices = [
    row("product_price_records", {
      id: "9007199254740993",
      product_id: "1",
      timestamp: "2026-02-02T10:00:00.123456Z",
      price: 10.25,
    }),
    row("product_price_records", {
      id: "9007199254740994",
      product_id: "1",
      timestamp: "2026-02-02T10:00:00.123456Z",
      price: 20.25,
    }),
    row("product_price_records", {
      id: "9007199254740995",
      product_id: "1",
      timestamp: "2026-02-02T10:00:00.123457Z",
      price: 30.25,
    }),
  ];
  expect(calculateCosts(source).totalCosts.products).toBe(40.5);
  source.deliveries[0].value.note.values.effective_timestamp =
    "2026-02-02T10:00:00.123455Z";
  expect(calculateCosts(source).totalCosts.products).toBe(20.5);
  source.deliveries[0].value.note.values.effective_timestamp =
    "2026-02-02T10:00:00.123457Z";
  expect(calculateCosts(source).totalCosts.products).toBe(60.5);
});

test("labour rates require a stored fragment and support explicit nulls", () => {
  const source = sourceRows().source;
  const { costs } = source.daily[0];
  costs.costs[0].costPerHour = null;
  expect(calculateCosts(source).commonCosts.fgk.baseCost).toBe(30);

  costs.projectId = "2";
  expect(() => calculateCosts(source)).toThrow();

  costs.projectId = "1";
  costs.costs.shift();
  expect(() => calculateCosts(source)).toThrow();
});

test("a special line without a recorded price contributes zero to project costs", () => {
  const source = sourceRows().source;
  source.deliveries[0].prices = undefined;

  const cost = calculateCosts(source);
  expect(cost.deliveryNotes[0].totalCost).toBe(20.5);
  expect(cost.specialRecords[0]).toMatchObject({
    pricePerUnit: null,
    totalCost: 0,
  });
});

test("authorized local reporting returns complete source costs and never calls a plaintext cost RPC", async () => {
  const f = await fixture();
  try {
    expect(
      await f.store.query("projects.costs.get", { projectId: "1" }),
    ).toEqual(calculateCosts(f.source));
    const app = createBusinessClient(f.client, { productDriver: duckDriver });
    try {
      const [cost, error] = await app.query("projects.costs.get", {
        projectId: "1",
      });
      expect(error).toBeNull();
      expect(cost.totalCosts.overall).toBe(227.7);
    } finally {
      app.dispose();
    }
    expect(
      f.calls.some((call) => call.path.startsWith("projects.costs.")),
    ).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain("relative_factor");
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("project costs use the new price after the catalog snapshot changes", async () => {
  const f = await fixture();
  const report = () => f.store.query("projects.costs.get", { projectId: "1" });

  try {
    expect((await report()).totalCosts.deliveryNotes).toBe(27.25);
    const area = f.requests.productPrices.area;
    const [previous] = f.source.productPrices;
    await f.seed(area, area.prefix + publicId(previous.values.id), {
      format: "sortsys-product-price-v1",
      price: { ...previous, values: { ...previous.values, price: 11.5 } },
    });
    await f.store.refresh();
    expect((await report()).totalCosts.deliveryNotes).toBe(29.75);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("overview labor follows Master while projects without billing access retain no costs", async () => {
  const f = await fixture(
    (area) =>
      area.scope === "project:2" && area.facet === "billing"
        ? []
        : ["read", "create", "update", "delete"],
    true,
  );
  f.state.roles = [":admin"];
  try {
    const rows = await f.store.query("projects.costs.overview", {
      status: "all",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      projectId: "1",
      accessError: null,
    });

    // The Master overview omits the external entry (1.25 hours at 8),
    // but the detail includes it in its labor and overall costs.
    const detail = await f.store.query("projects.costs.get", { projectId: "1" });
    expect(detail.workHours).toContainEqual(
      expect.objectContaining({ contractType: "external", totalCost: 10 }),
    );
    expect(detail.totalCosts.overall).toBeCloseTo(227.7, 8);
    expect(rows[0].costs).toBeCloseTo(217.7, 8);
    expect(rows[0].gainOrLoss).toBeCloseTo(32.3, 8);

    expect(rows[1]).toMatchObject({
      projectId: "2",
      costs: null,
      offersTotal: null,
      invoicesTotal: null,
      hasInvoices: null,
    });
    expect(rows[1].accessError).toContain("Rechnungswerte");
    await expect(
      f.store.query("projects.costs.get", { projectId: "2" }),
    ).rejects.toThrow("Rechnungswerte");
    expect(await f.store.query("projects.costs.filterOptions")).toEqual({
      finishingYears: [2025],
      projectLeaders: [],
    });
    expect(
      (
        await f.store.query("projects.costs.overview", { status: "active" })
      ).map((row) => row.projectId),
    ).toEqual(["1"]);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, 120000);

test("an authorized empty project has real zero costs and no invoice-based gain", async () => {
  const f = await fixture(undefined, true);
  try {
    const cost = await f.store.query("projects.costs.get", { projectId: "2" });
    expect(cost.totalCosts.overall).toBe(0);
    const rows = await f.store.query("projects.costs.overview", {
      status: "finished",
      closingYear: 2025,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "2",
      costs: 0,
      hasInvoices: false,
      gainOrLoss: null,
      accessError: null,
    });
    for (const input of [
      { status: "bad" },
      { closingYear: 2025.5 },
      { responsibleProjectLeaderUserId: "00" },
    ]) {
      await expect(
        f.store.query("projects.costs.overview", input),
      ).rejects.toThrow();
    }
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("financial creation is idempotent and update/delete require the matching financial facet", async () => {
  const f = await fixture();
  try {
    const value = {
      projectId: "1",
      type: "invoice",
      operationId: "abc",
      amount: 73.25,
      comment: " Gerüst ",
    };
    await f.finance.mutate("projects.costs.entries.create", value);
    await f.finance.mutate("projects.costs.entries.create", value);
    let cost = await f.store.query("projects.costs.get", { projectId: "1" });
    expect(cost.invoices.filter((entry) => entry.id === "abc")).toHaveLength(1);
    await expect(
      f.finance.mutate("projects.costs.entries.create", {
        ...value,
        amount: 75,
      }),
    ).rejects.toThrow();
    await f.finance.mutate("projects.costs.entries.update", {
      projectId: "1",
      id: "abc",
      data: { amount: 81.375, comment: " Neu " },
    });
    cost = await f.store.query("projects.costs.get", { projectId: "1" });
    expect(cost.invoices.find((entry) => entry.id === "abc")).toMatchObject({
      amount: 81.375,
      comment: "Neu",
      createdByUserId: "1",
    });
    await f.finance.mutate("projects.costs.entries.delete", {
      projectId: "1",
      id: "abc",
    });
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).invoices.some((entry) => entry.id === "abc"),
    ).toBe(false);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("lost acknowledgements do not duplicate entries and false acknowledgements do not save them", async () => {
  const f = await fixture();
  try {
    const value = {
      projectId: "1",
      type: "offer",
      operationId: "abd",
      amount: 83.375,
    };
    f.state.loseReply = true;
    await f.finance.mutate("projects.costs.entries.create", value);
    f.state.loseReply = false;
    await f.finance.mutate("projects.costs.entries.create", value);
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).offers.filter((entry) => entry.id === "abd"),
    ).toHaveLength(1);
    f.state.discardCommit = true;
    await expect(
      f.finance.mutate("projects.costs.entries.create", {
        ...value,
        operationId: "abe",
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).offers.some((entry) => entry.id === "abe"),
    ).toBe(false);
  } finally {
    f.state.discardCommit = false;
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("managed contract values cannot be bypassed through a manual offer entry", async () => {
  const f = await fixture();
  try {
    const register = emptyProjectCommercial("1", "offer-prices");
    register.mainCaseId = "3";
    await f.seed(
      f.requests.workflow.area,
      f.requests.workflow.area.prefix + "register",
      register,
    );
    await f.finance.refresh();
    await expect(
      f.finance.mutate("projects.costs.entries.create", {
        projectId: "1",
        type: "offer",
        amount: 100,
      }),
    ).rejects.toThrow("Nachtragsangebot");
    await f.finance.mutate("projects.costs.entries.create", {
      projectId: "1",
      type: "invoice",
      amount: 100,
    });
    expect(
      (await f.store.query("projects.costs.get", { projectId: "1" })).invoices,
    ).toHaveLength(2);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("a lost cost fragment and account locking fail visibly instead of reusing incomplete cached totals", async () => {
  const f = await fixture();
  try {
    await f.store.query("projects.costs.get", { projectId: "1" });
    f.objects.delete(f.requests.toolPrices.area.prefix + publicId("90"));
    f.domains.get(f.requests.toolPrices.area.domain).head++;
    await f.store.refresh();
    await expect(
      f.store.query("projects.costs.get", { projectId: "1" }),
    ).rejects.toThrow();
    await lockCryptoSession();
    await expect(
      f.store.query("projects.costs.overview", {}),
    ).rejects.toThrow();
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("invoice creation does not confer offer, invoice-update or deletion rights even to an administrator", async () => {
  const f = await fixture((area) =>
    area.scope === "project:1" && area.facet === "billing"
      ? ["read", "create"]
      : ["read"],
  );
  f.state.roles = [":admin"];
  try {
    await f.finance.mutate("projects.costs.entries.create", {
      projectId: "1",
      type: "invoice",
      operationId: "af1",
      amount: 91.125,
    });
    await expect(
      f.finance.mutate("projects.costs.entries.create", {
        projectId: "1",
        type: "offer",
        amount: 91.125,
      }),
    ).rejects.toThrow();
    await expect(
      f.finance.mutate("projects.costs.entries.update", {
        projectId: "1",
        id: "af1",
        data: { amount: 100 },
      }),
    ).rejects.toThrow();
    await expect(
      f.finance.mutate("projects.costs.entries.delete", {
        projectId: "1",
        id: "af1",
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).invoices.find((entry) => entry.id === "af1").amount,
    ).toBe(91.125);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("update-only and delete-only financial grants do not acquire creation rights", async () => {
  for (const action of ["update", "delete"]) {
    const f = await fixture((area) =>
      area.scope === "project:1" && area.facet === "billing"
        ? ["read", action]
        : ["read"],
    );
    try {
      await expect(
        f.finance.mutate("projects.costs.entries.create", {
          projectId: "1",
          type: "invoice",
          amount: 15,
        }),
      ).rejects.toThrow();
      if (action === "update") {
        await f.finance.mutate("projects.costs.entries.update", {
          projectId: "1",
          id: "b",
          data: { amount: 87.125 },
        });
        await expect(
          f.finance.mutate("projects.costs.entries.delete", {
            projectId: "1",
            id: "b",
          }),
        ).rejects.toThrow();
        expect(
          (await f.store.query("projects.costs.get", { projectId: "1" }))
            .invoices[0].amount,
        ).toBe(87.125);
      } else {
        await expect(
          f.finance.mutate("projects.costs.entries.update", {
            projectId: "1",
            id: "b",
            data: { amount: 87.125 },
          }),
        ).rejects.toThrow();
        await f.finance.mutate("projects.costs.entries.delete", {
          projectId: "1",
          id: "b",
        });
        expect(
          (await f.store.query("projects.costs.get", { projectId: "1" }))
            .invoices,
        ).toEqual([]);
      }
    } finally {
      f.store.close();
      f.finance.close();
    }
  }
}, fixtureTimeout(30000));

test("linked invoice values and malformed row bindings cannot be edited as manual entries", async () => {
  const f = await fixture();
  try {
    const entry = row("project_financial_entries", {
      id: "12",
      project_id: "1",
      type: "invoice",
      amount: 134,
      commercial_case_id: "3",
    });
    const object = financialObject(entry);
    const payload = {
      format: "sortsys-project-financial-v1",
      row: entry,
      exactAmount: "134.00",
    };
    for (const changed of [
      { ...payload, exactAmount: "135.00" },
      {
        ...payload,
        row: { ...entry, values: { ...entry.values, project_id: "2" } },
      },
      {
        ...payload,
        row: { ...entry, values: { ...entry.values, type: "offer" } },
      },
      {
        ...payload,
        row: {
          ...entry,
          values: { ...entry.values, commercial_case_id: null },
        },
      },
    ])
      expect(() =>
        financialPayload(changed, object, f.requests.issuedInvoices.area),
      ).toThrow();
    await f.seed(f.requests.issuedInvoices.area, object, payload);
    await expect(
      f.finance.mutate("projects.costs.entries.update", {
        projectId: "1",
        id: "c",
        data: { amount: 200 },
      }),
    ).rejects.toThrow();
    await expect(
      f.finance.mutate("projects.costs.entries.delete", {
        projectId: "1",
        id: "c",
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).invoices.find((entry) => entry.id === "c").commercialCaseId,
    ).toBe("3");
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("a concurrent managed baseline prevents a manual offer from being committed", async () => {
  const f = await fixture();
  let changed = false;
  f.state.beforeCommit = async () => {
    if (changed) return;
    changed = true;
    const register = emptyProjectCommercial("1", "offer-prices");
    register.mainCaseId = "3";
    await f.seed(
      f.requests.workflow.area,
      f.requests.workflow.area.prefix + "register",
      register,
    );
  };
  try {
    await expect(
      f.finance.mutate("projects.costs.entries.create", {
        projectId: "1",
        type: "offer",
        operationId: "ag1",
        amount: 100,
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).offers.some((entry) => entry.id === "ag1"),
    ).toBe(false);
    expect(changed).toBe(true);
  } finally {
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

test("a create retry after losing both acknowledgement and readback retains one financial operation", async () => {
  const f = await fixture();
  const query = f.client.query;
  let unavailable = false;
  f.client.query = async (path, ...args) => {
    if (
      unavailable &&
      (path === "zerotrust.objects.get" || path === "zerotrust.objects.list")
    )
      throw new Error("Synthetic unavailable readback");
    return query(path, ...args);
  };
  f.state.beforeCommit = async () => {
    unavailable = true;
  };
  f.state.loseReply = true;
  try {
    const value = {
      projectId: "1",
      type: "invoice",
      operationId: "ag2",
      amount: 91.125,
    };
    await expect(
      f.finance.mutate("projects.costs.entries.create", value),
    ).rejects.toThrow();
    unavailable = false;
    f.state.loseReply = false;
    await f.finance.mutate("projects.costs.entries.create", value);
    expect(
      (
        await f.store.query("projects.costs.get", { projectId: "1" })
      ).invoices.filter((entry) => entry.id === "ag2"),
    ).toHaveLength(1);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch"),
    ).toHaveLength(1);
  } finally {
    unavailable = false;
    f.store.close();
    f.finance.close();
  }
}, fixtureTimeout(30000));

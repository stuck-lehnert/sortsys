import { expect, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { businessSchema } from "./schema";
import {
  DELIVERY_MODEL,
  DELIVERY_PRICE_MODEL,
  calculateDeliveryCosts,
  deliveryCollection,
  deliveryDomain,
  deliveryPayload,
  deliveryPrices,
  wireDelivery,
  wireDeliveryCosts,
} from "./deliveryNoteData";
import { deliveryObject } from "./deliveryIdentity";
import { createProtectedDeliveryNotes } from "./deliveryNotes";
import { indexHistoricalPrices } from "./historicalPrices";
import { openDataDocument } from "./runtime/model";
import { dailyCollection } from "./dailyReportData";
import { regieCollection } from "./regieReportData";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { timestampMicros } from "./timestamps";

const row = (table, values) => ({
  format: "sortsys-row-v2",
  schema: businessSchema.fingerprint,
  table,
  values,
});

function deliveryCosts(payload, specialPrices, productPrices) {
  return wireDeliveryCosts(
    calculateDeliveryCosts(payload, specialPrices, indexHistoricalPrices(productPrices)),
  );
}
const date = "2026-11-11T11:12:13.000002Z";
function fixture() {
  const payload = {
    format: "sortsys-delivery-note-v1",
    note: row("product_delivery_notes", {
      id: "9223372036854775807",
      auto_id: "12",
      project_id: "2",
      created_by_user_id: "3",
      comment: "Fassade",
      created_at: date,
      effective_timestamp: date,
    }),
    records: [
      row("product_delivery_records", {
        id: "4",
        note_id: "9223372036854775807",
        product_id: "5",
        quantity: 2.375,
        unit: "Karton",
        comment: "Nicht runden",
      }),
    ],
    specialRecords: [
      row("product_delivery_special_records", {
        id: "6",
        note_id: "9223372036854775807",
        name: "Anlieferung",
        unit: "pauschal",
        amount: 1.125,
        price_per_unit: null,
        comment: null,
      }),
    ],
  };
  const prices = {
    format: "sortsys-delivery-prices-v1",
    projectId: "2",
    noteId: "7vvvvvvvvvvvv",
    prices: [{ id: "6", pricePerUnit: 23.4567 }],
  };
  return { payload, prices };
}
const price = (id, timestamp, value) =>
  row("product_price_records", {
    id,
    product_id: "5",
    vendor_id: null,
    timestamp,
    price: value,
    is_real_purchase: true,
    comment: null,
    created_at: date,
    modified_at: date,
  });

for (const canReadPrices of [true, false]) {
  test(`delivery detail reads only the selected objects (price access: ${canReadPrices})`, async () => {
    const quantityArea = deliveryCollection("2");
    const priceArea = deliveryCollection("2", true);
    const tenant = await protectedTenant([quantityArea, priceArea], ({ facet }) =>
      facet === "master-data" || canReadPrices ? ["read"] : [],
    );
    const { payload, prices } = fixture();
    const allocation = { id: prices.noteId, projectId: "2", number: "12" };
    const other = fixture();
    other.payload.note.values.id = "8";
    other.payload.note.values.auto_id = "13";
    other.payload.records[0].values.id = "9";
    other.payload.records[0].values.note_id = "8";
    other.payload.specialRecords[0].values.id = "10";
    other.payload.specialRecords[0].values.note_id = "8";
    other.prices.noteId = "8";
    other.prices.prices[0].id = "10";

    const quantityId = deliveryObject(allocation);
    const priceId = deliveryObject(allocation, true);
    const otherAllocation = { ...allocation, id: "8", number: "13" };
    const transport = {
      ...tenant.client,
      query(path, input, options) {
        if (path === "zerotrust.deliveryNotes.locate") {
          expect(input).toEqual({ number: allocation.number });
          return Promise.resolve([allocation, null]);
        }
        return tenant.client.query(path, input, options);
      },
    };
    const notes = createProtectedDeliveryNotes(
      transport,
      new AbortController().signal,
      duckDriver,
    );

    try {
      await tenant.seed(quantityArea, quantityId, payload);
      await tenant.seed(priceArea, priceId, prices);
      await tenant.seed(quantityArea, deliveryObject(otherAllocation), other.payload);
      await tenant.seed(priceArea, deliveryObject(otherAllocation, true), other.prices);

      const detail = await notes.query("deliveryNotes.get", { autoId: 12 });
      const selected = [];
      const contentPages = [];
      for (const { path, input } of tenant.calls) {
        if (path === "zerotrust.objects.get") selected.push(input.id);
        if (path === "zerotrust.objects.getMany") selected.push(...input.ids);
        if (path === "zerotrust.objects.list" && !input.headOnly) {
          contentPages.push(input);
        }
        if (path === "zerotrust.objects.pages") {
          contentPages.push(...input.selections.filter((page) => !page.headOnly));
        }
      }

      expect(contentPages).toEqual([]);
      expect(selected.sort()).toEqual(
        (canReadPrices ? [quantityId, priceId] : [quantityId]).sort(),
      );

      const list = await notes.query("deliveryNotes.list", { projectId: "2" });
      expect(list.map(({ autoId }) => autoId)).toEqual([13, 12]);
      expect(detail).toEqual(list[1]);
      expect(detail.specialRecords[0].pricePerUnit).toBe(canReadPrices ? 23.4567 : null);
      expect(detail.priceRevision).toBe(canReadPrices ? "1" : undefined);
    } finally {
      notes.close();
      lockCryptoSession();
    }
  });
}

test("delivery quantities and prices have separate project bindings and preserve identifiers and values", () => {
  const { payload, prices } = fixture(),
    area = deliveryCollection("2"),
    object = area.prefix + "7vvvvvvvvvvvv";
  expect(deliveryDomain(area.domain)).toEqual({
    projectId: "2",
    prices: false,
  });
  expect(deliveryDomain(deliveryCollection("2", true).domain)).toEqual({
    projectId: "2",
    prices: true,
  });
  expect(deliveryDomain("project:02:contract-quantities")).toBeNull();
  const value = deliveryPayload(payload, object, "2"),
    money = deliveryPrices(
      prices,
      deliveryCollection("2", true).prefix + prices.noteId,
      "2",
    );
  expect(value.note.values.id).toBe("9223372036854775807");
  expect(value.note.values.effective_timestamp).toBe(date);
  expect(wireDelivery(value).specialRecords[0].pricePerUnit).toBeNull();
  expect(wireDelivery(value, money).specialRecords[0].pricePerUnit).toBe(
    23.4567,
  );
  expect(wireDelivery(value).records[0].quantity).toBe(2.375);
});

test("a price hidden inside quantities and a substituted project, note or row cannot be accepted", () => {
  const { payload } = fixture(),
    object = deliveryCollection("2").prefix + "7vvvvvvvvvvvv";
  for (const alter of [
    (p) => {
      p.specialRecords[0].values.price_per_unit = 99;
    },
    (p) => {
      p.records[0].values.note_id = "8";
    },
    (p) => {
      p.note.values.project_id = "9";
    },
    (p) => {
      p.records.push(p.records[0]);
    },
    (p) => {
      p.specialRecords[0].values.extra = "not in schema";
    },
    (p) => {
      p.records[0].values.quantity = Infinity;
    },
  ]) {
    const copy = structuredClone(payload);
    alter(copy);
    expect(() => deliveryPayload(copy, object, "2")).toThrow(
      InvalidProtectedData,
    );
  }
  expect(() =>
    deliveryPayload(
      payload,
      deliveryCollection("3").prefix + "7vvvvvvvvvvvv",
      "3",
    ),
  ).toThrow();
});

test("price payloads reject another note, duplicated lines, unknown fields and non-finite money", () => {
  const { prices } = fixture(),
    object = deliveryCollection("2", true).prefix + prices.noteId;
  for (const alter of [
    (p) => {
      p.projectId = "3";
    },
    (p) => {
      p.noteId = "3";
    },
    (p) => {
      p.prices.push(p.prices[0]);
    },
    (p) => {
      p.prices[0].description = "secret";
    },
    (p) => {
      p.prices[0].pricePerUnit = NaN;
    },
  ]) {
    const copy = structuredClone(prices);
    alter(copy);
    expect(() => deliveryPrices(copy, object, "2")).toThrow();
  }
});

test("historical cost selection compares microseconds and numeric identifiers before converting to Date", () => {
  const { payload, prices } = fixture();
  const result = deliveryCosts(payload, prices, [
    price("30", "2026-11-11T12:12:13.000003+01:00", 100),
    price("32", date, 9.8765),
    price("31", date, 5),
    price("33", "2026-11-11T11:12:13.000001Z", 3),
  ]);
  expect(result.records[0].priceRecord.id).toBe("10");
  expect(result.records[0].priceRecord.price).toBe(9.8765);
  expect(result.specialRecords[0].totalCost).toBe(1.125 * 23.4567);
  expect(result.totalCost).toBe(2.375 * 9.8765 + 1.125 * 23.4567);
  expect(
    timestampMicros(date) - timestampMicros("2026-11-11T12:12:13.000001+01:00"),
  ).toBe(1n);
});

test("without a historical price the earliest future price and lowest tied id are used, missing prices stay null", () => {
  const { payload, prices } = fixture();
  const result = deliveryCosts(payload, prices, [
    price("32", "2026-12-01T00:00:00Z", 8),
    price("31", "2026-12-01T00:00:00Z", 7),
    price("30", "2027-01-01T00:00:00Z", 1),
  ]);
  expect(result.records[0].priceRecord.id).toBe("v");
  expect(result.records[0].priceRecord.price).toBe(7);
  const missing = deliveryCosts(payload, { ...prices, prices: [] }, []);
  expect(missing.records[0].priceRecord).toBeNull();
  expect(missing.specialRecords[0].pricePerUnit).toBeNull();
  expect(missing.totalCost).toBe(0);
});

test("costs reject mismatched prices, overflow and an auto number that the existing API cannot represent exactly", () => {
  const { payload, prices } = fixture();
  expect(() => wireDelivery(payload, { ...prices, noteId: "1" })).toThrow();
  expect(() =>
    deliveryCosts(payload, prices, [price("1", date, Number.MAX_VALUE)]),
  ).toThrow();
  payload.note.values.auto_id = "9223372036854775807";
  expect(
    deliveryPayload(
      payload,
      deliveryCollection("2").prefix + prices.noteId,
      "2",
    ).note.values.auto_id,
  ).toBe("9223372036854775807");
  expect(() => wireDelivery(payload)).toThrow();
});

test("delivery models reject another module, a substituted scope, facet or object prefix", () => {
  const { payload, prices } = fixture(),
    area = deliveryCollection("2"),
    money = deliveryCollection("2", true);
  for (const changed of [
    dailyCollection("2"),
    regieCollection("2"),
    { ...area, scope: "project:2" },
    { ...area, facet: "procurement" },
    { ...area, prefix: "anything:" },
  ])
    expect(() =>
      openDataDocument(DELIVERY_MODEL, changed, {
        envelope: { object: area.prefix + prices.noteId, revision: "1" },
        value: payload,
      }),
    ).toThrow();
  expect(() =>
    openDataDocument(DELIVERY_PRICE_MODEL, area, {
      envelope: { object: money.prefix + prices.noteId, revision: "1" },
      value: prices,
    }),
  ).toThrow();
});

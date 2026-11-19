import { expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { deliveryScanPrefill, scannedDeliveryRequestId } from "./deliveryScanPrefill";
import { protectedTenant } from "./testing/protectedTenant.mjs";

const scan = { id: "3", createdAt: new Date("2026-11-08T10:11:12Z") };
const line = {
  productId: "7",
  productName: "Mauermörtel",
  quantity: 60,
  displayQuantity: 2,
  unit: "Sack",
  baseUnit: "kg",
  comment: "Rampe Süd",
};
const result = {
  supplier: "Baustoffhandel",
  deliveryNumber: "LE-761",
  deliveryDate: null,
  records: [line],
  specialRecords: [],
  warnings: [],
};
const product = {
  id: line.productId,
  name: "Mauermörtel, neue Bezeichnung",
  baseUnit: "kg",
  otherUnits: { Säcke: 30 },
};

test("a reopened scan retains a matching package quantity and current unit spelling", () => {
  const prefill = deliveryScanPrefill(scan, result, [product]);
  expect(prefill.scanId).toBe(scan.id);
  expect(prefill.deliveryDate.getHours()).toBe(12);
  expect(prefill.deliveryDate.getDate()).toBe(scan.createdAt.getDate());
  expect(prefill.records).toEqual([{ product, amount: 2, unit: "Säcke", comment: line.comment }]);
  expect(prefill.warnings).toEqual([]);
});

test("missing products and incompatible packaging keep the source amount as a special item", () => {
  for (const catalogue of [[], [{ ...product, otherUnits: { Sack: 25 } }], [{ ...product, baseUnit: "g" }]]) {
    const prefill = deliveryScanPrefill(scan, result, catalogue);
    expect(prefill.records).toEqual([]);
    expect(prefill.specialRecords).toEqual([{
      name: line.productName,
      amount: 2,
      unit: "Sack",
      pricePerUnit: null,
      comment: line.comment,
    }]);
    expect(prefill.warnings).toHaveLength(1);
  }
  expect(result.warnings).toEqual([]);
});

test("an identical scan submission reuses the private operation ID across new drafts", async () => {
  await protectedTenant([]);
  try {
    const input = {
      projectId: "1",
      effectiveTimestamp: new Date("2026-11-08T12:00:00Z"),
      specialRecords: [{ name: "Mauermörtel", unit: "Sack", amount: 2 }],
    };
    const id = await scannedDeliveryRequestId(scan.id, input);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await scannedDeliveryRequestId(scan.id, structuredClone(input))).toBe(id);
    expect(await scannedDeliveryRequestId("4", input)).not.toBe(id);
    expect(await scannedDeliveryRequestId(scan.id, { ...input, projectId: "2" })).not.toBe(id);
    expect(await scannedDeliveryRequestId(scan.id, { ...input, comment: "Nach Prüfung" })).not.toBe(id);
  } finally {
    await lockCryptoSession();
  }
});

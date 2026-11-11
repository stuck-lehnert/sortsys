import { expect, test } from "bun:test";
import { normalizeScanResult, parseRawScan, proposedScanUnits, validateScanResult } from "./scanResult";
import { scanProductSearch } from "./imports";

const product = { id: "abc", customId: 4711, name: "Perlfix", brand: "Knauf", description: "Ansetzbinder für Gipsplatten", baseUnit: "kg", otherUnits: { Sack: 30, Palette: 1200 }, categories: [], regieReportName: null };
const line = { sourceText: "KNAUF PERLFIX 30 KG", name: "Perlfix", brand: "Knauf", description: null, quantity: 2.5, unit: "Sack", baseUnit: "kg", unitConversions: [], productId: "abc", pricePerUnit: 7.29, confidence: .9, comment: null };
function raw(documentType, lines) { return { documentType, supplier: "Lieferant", documentNumber: "2026-1", documentDate: "2026-11-09", comment: null, lines }; }

test("recognized quantities and discounted prices use the local catalogue's unit factors", () => {
  const delivery = normalizeScanResult(parseRawScan(JSON.stringify(raw("deliveryNote", [line]))), [product]);
  expect(delivery.deliveryNote.records[0]).toMatchObject({ productId: "abc", quantity: 75, displayQuantity: 2.5, unit: "Sack", baseUnit: "kg" });
  expect(validateScanResult(delivery)).toEqual(delivery);
  const prices = normalizeScanResult(raw("priceList", [{ ...line, sourceText: "Perlfix | 8,10 | Sack | 10% | 7,29", pricePerUnit: 8.1 }]), [product]);
  expect(prices.priceList.rows[0].pricePerBaseUnit).toBeCloseTo(.243, 10);
  expect(validateScanResult(prices)).toEqual(prices);
});

test("unmatched packaging resolves nested units and rejects cycles or contradictory factors", () => {
  const packaging = { ...line, productId: null, unit: "Palette", baseUnit: "Palette", unitConversions: [{ unit: "Palette", quantity: 40, inUnit: "Sack" }, { unit: "Sack", quantity: 30, inUnit: "kg" }] };
  expect(proposedScanUnits(packaging)).toEqual({ baseUnit: "kg", otherUnits: { Sack: 30, Palette: 1200 }, factor: 1200 });
  expect(proposedScanUnits({ ...packaging, unitConversions: [{ unit: "Palette", quantity: 40, inUnit: "Sack" }, { unit: "Sack", quantity: 30, inUnit: "Palette" }] })).toBeNull();
  expect(proposedScanUnits({ ...packaging, unitConversions: [...packaging.unitConversions, { unit: "Sack", quantity: 25, inUnit: "kg" }] })).toBeNull();
  const result = normalizeScanResult(raw("invoice", [{ ...packaging, pricePerUnit: 1200 }]), []);
  expect(result.priceList.rows[0]).toMatchObject({ baseUnit: "kg", pricePerBaseUnit: 1, productId: null });
});

test("unknown product ids remain special items; invalid result schemas cannot be persisted or reopened", () => {
  const result = normalizeScanResult(raw("deliveryNote", [{ ...line, productId: "def" }]), [product]);
  expect(result.deliveryNote.records).toEqual([]); expect(result.deliveryNote.specialRecords[0].amount).toBe(2.5);
  expect(result.deliveryNote.warnings.length).toBe(1);
  for (const altered of [{ ...line, quantity: 0 }, { ...line, unitConversions: [{ unit: "Sack", quantity: 0, inUnit: "kg" }] }, { ...line, hiddenColumn: "bad" }]) {
    expect(() => parseRawScan(JSON.stringify(raw("deliveryNote", [altered])))).toThrow();
  }
  const invalid = structuredClone(result); invalid.deliveryNote.specialRecords[0].amount = Infinity;
  expect(() => validateScanResult(invalid)).toThrow();
  const wrongKind = { ...result, documentType: "invoice" }; expect(() => validateScanResult(wrongKind)).toThrow();
});

test("product search includes descriptions, retries meaningful fragments, and never returns prices", () => {
  expect(scanProductSearch([product], { query: "Gipsplatten" }).records).toHaveLength(1);
  expect(scanProductSearch([product], { query: "KNAUF-ANSETZB.-PERLFIX A 30 KG (1 PAL. = 40 SACK)" }).records).toHaveLength(1);
  expect(Object.keys(scanProductSearch([{ ...product, price: 999 }], { query: "Perlfix" }).records[0])).toEqual(["id", "customId", "name", "brand", "description", "baseUnit", "otherUnits"]);
});

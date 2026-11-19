import { expect, test } from "bun:test";
import { createAccountDataKey } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import {
  priceImportFingerprint,
  priceImportInput,
  priceImportReceipt,
  scannedPriceRequestId,
} from "./priceImports";
import { scanProductUnit } from "./scanResult";
import { protectedTenant } from "./testing/protectedTenant.mjs";

const requestId = "import-test-20261111-0001";
function input() {
  return {
    requestId,
    vendorId: "12",
    effectiveAt: new Date("2026-11-11T12:00:00Z"),
    isRealPurchase: false,
    rows: [
      {
        productId: null,
        productName: " Anschlussprofil ",
        baseUnit: "m",
        pricePerBaseUnit: 12345.6789,
        otherUnits: { Rolle: 25, Karton: 100 },
        comment: " Netto laut Preisliste ",
      },
    ],
  };
}

test("price imports validate and normalize the complete input before encrypting anything", () => {
  const value = priceImportInput(input());
  expect(value.rows[0].productName).toBe("Anschlussprofil");
  expect(value.rows[0].pricePerBaseUnit).toBe(12345.6789);
  expect(value.rows[0].comment).toBe("Netto laut Preisliste");
  expect(Object.keys(value.rows[0].otherUnits)).toEqual(["Karton", "Rolle"]);
  for (const changes of [
    { vendorId: "01" },
    { requestId: "../wrong" },
    { effectiveAt: "2026-11-11" },
    { isRealPurchase: 1 },
    { rows: [] },
    { unexpected: true },
  ])
    expect(() => priceImportInput({ ...input(), ...changes })).toThrow();
  for (const changes of [
    { pricePerBaseUnit: "2,5" },
    { pricePerBaseUnit: Infinity },
    { pricePerBaseUnit: -1 },
    { productName: " " },
    { baseUnit: "m".repeat(9) },
    { otherUnits: { m: 1 } },
    { otherUnits: { Rolle: 0 } },
    { otherUnits: { Rolle: Infinity } },
    { otherUnits: { Rolle: 25, rolle: 20 } },
    { comment: "x".repeat(256) },
    { admin: true },
  ]) {
    expect(() =>
      priceImportInput({
        ...input(),
        rows: [{ ...input().rows[0], ...changes }],
      }),
    ).toThrow();
  }
  expect(
    priceImportInput({
      ...input(),
      rows: Array.from({ length: 20_000 }, () => input().rows[0]),
    }).rows,
  ).toHaveLength(20_000);
  expect(() =>
    priceImportInput({
      ...input(),
      rows: Array.from({ length: 20_001 }, () => input().rows[0]),
    }),
  ).toThrow();
});

test("the retry fingerprint is stable across object key order and private to the account key", async () => {
  const key = await createAccountDataKey();
  const other = await createAccountDataKey();
  const value = priceImportInput(input()),
    hash = await priceImportFingerprint(key, "tenant", "user:1", value);
  const reordered = input();
  reordered.rows[0].otherUnits = { Karton: 100, Rolle: 25 };
  expect(
    await priceImportFingerprint(
      key,
      "tenant",
      "user:1",
      priceImportInput(reordered),
    ),
  ).toBe(hash);
  for (const [secret, tenant, user, data] of [
    [other, "tenant", "user:1", value],
    [key, "other", "user:1", value],
    [key, "tenant", "user:2", value],
    [
      key,
      "tenant",
      "user:1",
      {
        ...value,
        requestId: "a-new-request-id-20261111",
      },
    ],
    [
      key,
      "tenant",
      "user:1",
      {
        ...value,
        rows: [{ ...value.rows[0], pricePerBaseUnit: 2.5 }],
      },
    ],
  ]) {
    expect(await priceImportFingerprint(secret, tenant, user, data)).not.toBe(
      hash,
    );
  }
});

test("a conversion binds a mapped price to a valid package factor", () => {
  const value = input();
  const row = { ...value.rows[0], productId: "7" };
  expect(priceImportInput(value).rows[0]).not.toHaveProperty("sourceConversion");
  expect(priceImportInput({
    ...value,
    rows: [{ ...row, sourceConversion: { unit: " Rolle ", factor: 25 } }],
  }).rows[0].sourceConversion).toEqual({ unit: "Rolle", factor: 25 });

  for (const changes of [
    { sourceConversion: { unit: "Rolle", factor: 0 } },
    { sourceConversion: { unit: "Rolle", factor: Infinity } },
    { sourceConversion: { unit: "", factor: 25 } },
    { sourceConversion: { unit: "Rolle", factor: 25, extra: true } },
    { productId: null, sourceConversion: { unit: "Rolle", factor: 25 } },
  ]) {
    expect(() => priceImportInput({ ...value, rows: [{ ...row, ...changes }] })).toThrow();
  }
});

test("package lookup prefers an exact spelling and rejects conflicting aliases", () => {
  const product = { baseUnit: "kg", otherUnits: { Sack: 30, Säcke: 25 } };
  expect(scanProductUnit(product, "Sack")).toEqual({ unit: "Sack", factor: 30 });
  expect(scanProductUnit(product, "Säcke")).toEqual({ unit: "Säcke", factor: 25 });
  expect(scanProductUnit(product, "SACK")).toBeNull();
  expect(scanProductUnit(product, "KG")).toEqual({ unit: "kg", factor: 1 });
});

test("reopened price scans use the same private identifier for the same normalized input", async () => {
  await protectedTenant([]);
  try {
    const value = input();
    const reopened = structuredClone(value);
    delete reopened.requestId;
    reopened.rows[0].otherUnits = { Karton: 100, Rolle: 25 };
    const first = await scannedPriceRequestId("3", value);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await scannedPriceRequestId("3", reopened)).toBe(first);
    expect(await scannedPriceRequestId("4", reopened)).not.toBe(first);
    expect(await scannedPriceRequestId("3", { ...reopened, vendorId: "13" })).not.toBe(first);
    expect(await scannedPriceRequestId("3", { ...reopened, isRealPurchase: true })).not.toBe(first);
  } finally {
    await lockCryptoSession();
  }
});

test("import receipts cannot smuggle product descriptions or inconsistent counts", () => {
  const value = {
    format: "sortsys-price-import-v1",
    requestId,
    author: "user:1",
    requestHash: "A".repeat(43),
    createdAt: "2026-11-11T12:00:00.000Z",
    createdProducts: 1,
    createdPriceRecords: 2,
  };
  expect(priceImportReceipt(value)).toEqual(value);
  for (const changes of [
    { description: "private product text" },
    { author: "user:01" },
    { createdProducts: 3 },
    { createdPriceRecords: 0 },
    { createdProducts: -1 },
    { createdPriceRecords: 20_001 },
    { createdAt: "2026-02-30" },
  ])
    expect(() => priceImportReceipt({ ...value, ...changes })).toThrow();
});

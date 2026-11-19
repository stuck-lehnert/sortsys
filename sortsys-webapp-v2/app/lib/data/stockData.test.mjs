import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { managedAccess } from "../crypto/accessProfiles";
import { pricePayload, publicId } from "./products";
import { createPrefixMatcher } from "../search/prefixQuery";
import { priceChanges } from "./prices";
import { vendorChanges, vendorPayload } from "./vendorData";

test("supplier payloads contain only their bound name, description and row metadata", () => {
  const vendor = row("product_vendors", { id: "9223372036854775807", name: "Fassadenbedarf", description: "Anschlussprofile und Fugendichtstoffe" });
  const object = `vendor:${publicId(vendor.values.id)}`, payload = { format: "sortsys-vendor-v1", vendor };
  expect(vendorPayload(payload, object).vendor.values.description).toBe(vendor.values.description);
  expect(() => vendorPayload(payload, "vendor:1")).toThrow();
  expect(() => vendorPayload({ ...payload, prices: [12.34] }, object)).toThrow();
  expect(() => vendorPayload({ ...payload, vendor: { ...vendor, values: { ...vendor.values, purchase_price: 12.34 } } }, object)).toThrow();
  expect(vendorPayload({ ...payload, vendor: { ...vendor, values: { ...vendor.values, name: "Ä".repeat(127), description: "Ä".repeat(255) } } }, object).vendor.values.name).toBe("Ä".repeat(127));
  expect(() => vendorChanges({ name: " " }, true)).toThrow();
  expect(() => vendorChanges({ description: "x".repeat(256) }, false)).toThrow();
  expect(createPrefixMatcher("Anschluss Fugen")([vendor.values.name, vendor.values.description])).toBe(true);
  expect(createPrefixMatcher("0")([vendor.values.name, vendor.values.description])).toBe(false);
});

test("price inputs retain floats and reject invalid dates, references, extra fields and implicit coercion", () => {
  const data = { productId: "7vvvvvvvvvvvv", vendorId: "12", pricePerBaseUnit: 12345.6789,
    timestamp: new Date("2026-11-11T12:13:14.567Z"), isRealPurchase: true, comment: "Privater Einkaufspreis" };
  expect(priceChanges(data, true)).toEqual({ product_id: "9223372036854775807", vendor_id: "34", price: 12345.6789,
    timestamp: "2026-11-11T12:13:14.567Z", is_real_purchase: true, comment: data.comment });
  expect(priceChanges({ comment: null }, false)).toEqual({ comment: null });
  expect(priceChanges({ vendorId: null }, false)).toEqual({ vendor_id: null });
  for (const fields of [{ productId: "0" }, { productId: "8000000000000" }, { vendorId: "../12" }, { pricePerBaseUnit: "2,5" },
    { pricePerBaseUnit: Infinity }, { pricePerBaseUnit: NaN }, { timestamp: new Date(NaN) }, { timestamp: "2026-11-11" },
    { isRealPurchase: 1 }, { comment: "x".repeat(256) }, { purchasePrice: 12.34 }]) expect(() => priceChanges({ ...data, ...fields }, true)).toThrow();
});

test("deleting a price requires a signed deletion proof instead of an empty encrypted row", () => {
  const payload = { format: "sortsys-product-price-v1", price: null };
  expect(() => pricePayload(payload, "product-price:7vvvvvvvvvvvv")).toThrow();
  for (const id of ["product:12", "product-price:0", "product-price:01", "product-price:8000000000000", "product-price:../12"]) expect(() => pricePayload(payload, id)).toThrow();
  expect(() => pricePayload({ ...payload, comment: "Private" }, "product-price:12")).toThrow();
});

test("supplier and price permissions are independent none/read/write choices", () => {
  const permissions = { catalogue: "none", customers: "none", contacts: "none", vendors: "write", prices: "read", assistant: false };
  expect(managedAccess(permissions)).toEqual(permissions);
  for (const changes of [{ prices: true }, { vendors: true }, { prices: "administrator" }, { description: "not a grant" }]) expect(() => managedAccess({ ...permissions, ...changes })).toThrow();
});

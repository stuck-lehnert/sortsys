import { test, expect } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { createProductMatcher, pricePayload, productPayload, publicId } from "./products";

test("product objects bind their canonical identity and exclude price/personnel columns", () => {
  const product = row("products", { id: "9223372036854775807", custom_id: "17", name: "Anschlussprofil", description: "Fensterlaibung abdichten", base_unit: "m" });
  const id = `product:${publicId(product.values.id)}`;
  const payload = { format: "sortsys-product-v1", product, categories: [] };
  expect(productPayload(payload, id).product.values.id).toBe("9223372036854775807");
  expect(() => productPayload(payload, "product:1")).toThrow();
  expect(() => productPayload({ ...payload, prices: [] }, id)).toThrow();
  expect(() => productPayload({ ...payload, product: { ...product, values: { ...product.values, price: 23.45 } } }, id)).toThrow();
  for (const invalid of [{ custom_id: "-1" }, { name: "  " }, { base_unit: "" }, { other_units: "[]" }]) {
    expect(() => productPayload({ ...payload, product: { ...product, values: { ...product.values, ...invalid } } }, id)).toThrow();
  }
  expect(() => publicId("9223372036854775808")).toThrow();
});

test("categories cannot point at another product or bypass case-insensitive uniqueness", () => {
  const product = row("products", { id: "100" });
  const payload = { format: "sortsys-product-v1", product, categories: [row("product_categories", { product_id: "100", category: "Putz" })] };
  const id = `product:${publicId("100")}`;
  expect(productPayload(payload, id).categories.length).toBe(1);
  expect(() => productPayload({ ...payload, categories: [row("product_categories", { product_id: "101", category: "Putz" })] }, id)).toThrow();
  expect(() => productPayload({ ...payload, categories: [...payload.categories, row("product_categories", { product_id: "100", category: "PUTZ" })] }, id)).toThrow();
});

test("price objects require their own format, table and identity", () => {
  const price = row("product_price_records", { id: "100", price: 97531.2468 });
  const payload = { format: "sortsys-product-price-v1", price };
  const id = `product-price:${publicId("100")}`;
  expect(pricePayload(payload, id).price.values.price).toBe(97531.2468);
  expect(() => pricePayload(payload, `product:${publicId("100")}`)).toThrow();
  expect(() => productPayload(payload, id)).toThrow();
  expect(() => pricePayload({ ...payload, price: row("users", { id: "100" }) }, id)).toThrow();
});

test("local product search includes descriptions and combines word prefixes", () => {
  const product = { customId: 4711, name: "Profil", brand: null, description: "Für äußere Fensterlaibungen", regieReportName: null };
  expect(createProductMatcher("ÄUẞERE Fenst")(product)).toBe(true);
  expect(createProductMatcher("471 Pro")(product)).toBe(true);
  expect(createProductMatcher("Fenst Innen")(product)).toBe(false);
});

test("a verified historical vendor deletion cannot erase a newly assigned vendor during a price patch", async () => {
  const { PRICE_MODEL } = await import("./products"), { openDataDocument } = await import("./runtime/model");
  const area = { domain: "catalog:products:procurement", scope: "catalog:products", facet: "procurement", prefix: "product-price:" };
  const price = row("product_price_records", { id: "200", product_id: "1", vendor_id: "100", price: 50.019999999999996 });
  const object = { envelope: { object: `product-price:${publicId("200")}`, revision: "1" }, value: { format: "sortsys-product-price-v1", price }, stock: { vendorDeletion: { object: `vendor:${publicId("100")}` } } };
  const opened = openDataDocument(PRICE_MODEL, area, object); expect(opened.value.price.values.vendor_id).toBeNull();
  const edited = { ...opened.value, price: { ...opened.value.price, values: { ...opened.value.price.values, comment: "Edited after supplier deletion", vendor_id: "101" } } };
  expect(openDataDocument(PRICE_MODEL, area, { ...object, value: edited }).value.price.values.vendor_id).toBe("101");
  expect(openDataDocument(PRICE_MODEL, area, { ...object, value: opened.value }).value.price.values.vendor_id).toBeNull();
  expect(() => openDataDocument(PRICE_MODEL, area, { ...object, stock: undefined })).toThrow();
  expect(openDataDocument(PRICE_MODEL, area, { ...object, stock: undefined, envelope: { ...object.envelope, revision: "0" } }).value.price.values.vendor_id).toBe("100");
});

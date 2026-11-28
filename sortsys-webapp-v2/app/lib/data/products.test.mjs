import { test, expect } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { row } from "./rowCodec.test.mjs";
import {
  createProductMatcher,
  openProtectedProducts,
  pricePayload,
  PRODUCT_COLLECTION,
  productPayload,
  publicId,
} from "./products";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

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

test("opening the catalogue leaves the first protected read to the requested operation", async () => {
  const fixture = await protectedTenant([PRODUCT_COLLECTION]);
  const product = row("products", {
    id: "10",
    custom_id: "17",
    name: "Anschlussprofil",
    description: "Fensterlaibung abdichten",
  });
  await fixture.seed(PRODUCT_COLLECTION, `product:${publicId("10")}`, {
    format: "sortsys-product-v1",
    product,
    categories: [],
  });
  fixture.calls.length = 0;
  const catalogue = openProtectedProducts(
    fixture.client,
    new AbortController().signal,
    duckDriver,
  );
  try {
    expect(fixture.calls).toEqual([]);
    expect((await catalogue.list({})).map((item) => item.name)).toEqual([
      "Anschlussprofil",
    ]);
    expect((await catalogue.list({ search: "Fensterl" }))[0].customId).toBe(17);
    const snapshots = fixture.calls.filter(
      ({ path }) => path === "zerotrust.access.snapshot",
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].input.domains).toEqual([PRODUCT_COLLECTION.domain]);
  } finally {
    await catalogue.close();
    await lockCryptoSession();
  }
});

test("product references fetch only the requested catalogue objects", async () => {
  const fixture = await protectedTenant([PRODUCT_COLLECTION]);
  const catalogue = openProtectedProducts(
    fixture.client,
    new AbortController().signal,
    duckDriver,
  );

  try {
    for (let number = 1; number <= 40; number++) {
      const id = String(number);
      const product = row("products", {
        id,
        custom_id: id,
        name: `Produkt ${id}`,
      });

      await fixture.seed(PRODUCT_COLLECTION, `product:${publicId(id)}`, {
        format: "sortsys-product-v1",
        product,
        categories: [],
      });
    }

    fixture.calls.length = 0;
    const ids = ["1", publicId("40"), publicId("41")];
    const [first, last, missing] = await Promise.allSettled(
      ids.map((id) => catalogue.get(id)),
    );

    expect(first).toMatchObject({
      status: "fulfilled",
      value: { name: "Produkt 1" },
    });
    expect(last).toMatchObject({
      status: "fulfilled",
      value: { name: "Produkt 40" },
    });
    expect(missing.status).toBe("rejected");

    const selected = fixture.calls
      .filter(({ path }) => path === "zerotrust.objects.getMany")
      .map(({ input }) => input.ids);
    expect(selected).toEqual([ids.map((id) => `product:${id}`)]);

    fixture.calls.length = 0;
    expect(await catalogue.get(ids[0])).toEqual(first.value);
    expect(fixture.calls).toEqual([]);

    expect(await catalogue.list({})).toHaveLength(40);
    fixture.calls.length = 0;
    expect(await catalogue.get(ids[1])).toEqual(last.value);
    expect(fixture.calls).toEqual([]);
  } finally {
    await catalogue.close();
    await lockCryptoSession();
  }
}, 45_000);

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

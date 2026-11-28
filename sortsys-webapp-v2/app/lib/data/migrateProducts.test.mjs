import * as databaseReader from "./database";
import { expect, spyOn, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import * as session from "../crypto/session";
import * as copy from "./copyCollection";
import { prepareProductCatalog } from "./migrateProducts";
import * as setup from "./prepareCollections";
import * as products from "./products";
import { VENDOR_COLLECTION, vendorPayload } from "./vendorData";

test.each([false, true])("catalogue migration shares provisioning (account changed: %s)", async (switchAccount) => {
  const product = {
    format: "sortsys-product-v1",
    product: { values: { id: "9" } },
    categories: [],
  };
  const vendor = { values: { id: "10" } };
  const price = { values: { id: "11" } };
  const client = {};
  const database = {};
  const subject = "user:owner";
  const signal = new AbortController().signal;
  const areas = [
    products.PRODUCT_COLLECTION,
    VENDOR_COLLECTION,
    products.PRICE_COLLECTION,
  ];

  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const prepare = spyOn(setup, "prepareOwnerCollections").mockResolvedValue(undefined);
  const readProducts = spyOn(products, "productPayloads").mockResolvedValue([product]);
  const readRows = spyOn(databaseReader, "readBusinessRows").mockImplementation(async (_, table) => {
    if (table === "product_vendors") {
      if (switchAccount) account.mockReturnValue({});
      return [vendor];
    }

    expect(table).toBe("product_price_records");
    return [price];
  });
  const publish = spyOn(copy, "copyProtectedAreas").mockResolvedValue(undefined);

  try {
    const migration = prepareProductCatalog(client, database, subject, signal);
    if (switchAccount) {
      await expect(migration).rejects.toBeInstanceOf(InvalidProtectedData);
      expect(publish).not.toHaveBeenCalled();
    } else {
      await migration;
      const entries = [
        {
          area: products.PRODUCT_COLLECTION,
          rows: [{ id: "product:9", value: product }],
          validate: products.productPayload,
        },
        {
          area: VENDOR_COLLECTION,
          rows: [{
            id: VENDOR_COLLECTION.prefix + "a",
            value: { format: "sortsys-vendor-v1", vendor },
          }],
          validate: vendorPayload,
        },
        {
          area: products.PRICE_COLLECTION,
          rows: [{
            id: "product-price:b",
            value: { format: "sortsys-product-price-v1", price },
          }],
          validate: products.pricePayload,
        },
      ];
      expect(publish.mock.calls).toEqual([[client, entries, signal]]);
    }

    expect(prepare.mock.calls).toEqual([[client, subject, areas, signal]]);
  } finally {
    for (const mock of [account, prepare, readProducts, readRows, publish]) mock.mockRestore();
  }
});

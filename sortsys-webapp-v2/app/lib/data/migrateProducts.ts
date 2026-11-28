import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { prepareOwnerCollections } from "./prepareCollections";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedAreas } from "./copyCollection";
import {
  PRICE_COLLECTION,
  PRODUCT_COLLECTION,
  pricePayload,
  productPayload,
  productPayloads,
  publicId,
} from "./products";
import { VENDOR_COLLECTION, vendorPayload } from "./vendorData";

async function vendorCopy(database: BusinessDatabase) {
  const vendors = await readBusinessRows(database, "product_vendors");
  return {
    area: VENDOR_COLLECTION,
    rows: vendors.map((vendor) => ({
      id: VENDOR_COLLECTION.prefix + publicId(vendor.values.id),
      value: { format: "sortsys-vendor-v1", vendor },
    })),
    validate: vendorPayload,
  };
}

/** Converts the verified owner archive into normal, independently keyed
 * catalogue objects. Retrying verifies existing objects rather than replacing
 * them. Other business tables/files still have to be converted before erase. */
export async function prepareProductCatalog(
  client: Client,
  database: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    if (signal.aborted || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  await prepareOwnerCollections(
    client,
    subject,
    [PRODUCT_COLLECTION, VENDOR_COLLECTION, PRICE_COLLECTION],
    signal,
  );
  live();
  const productRows = await productPayloads(database);
  live();
  const vendors = await vendorCopy(database);
  live();
  const prices = await readBusinessRows(database, "product_price_records");
  live();

  await copyProtectedAreas(
    client,
    [
      {
        area: PRODUCT_COLLECTION,
        rows: productRows.map((product) => ({
          id: PRODUCT_COLLECTION.prefix + publicId(product.product.values.id),
          value: product,
        })),
        validate: productPayload,
      },
      vendors,
      {
        area: PRICE_COLLECTION,
        rows: prices.map((price) => ({
          id: PRICE_COLLECTION.prefix + publicId(price.values.id),
          value: { format: "sortsys-product-price-v1", price },
        })),
        validate: pricePayload,
      },
    ],
    signal,
  );
}

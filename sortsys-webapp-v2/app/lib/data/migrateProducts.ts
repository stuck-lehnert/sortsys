import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { prepareOwnerCollections } from "./prepareCollections";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareVendors } from "./migrateVendors";
import {
  PRICE_COLLECTION,
  PRODUCT_COLLECTION,
  pricePayload,
  productPayload,
  productPayloads,
  publicId,
  readBusinessRows,
} from "./products";

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
    [PRODUCT_COLLECTION, PRICE_COLLECTION],
    signal,
  );
  live();
  const productRows = await productPayloads(database);
  live();
  const prices = await readBusinessRows(database, "product_price_records");
  live();
  await copyProtectedCollection(
    client,
    PRODUCT_COLLECTION,
    productRows.map((p) => ({
      id: `product:${publicId(p.product.values.id)}`,
      value: p,
    })),
    productPayload,
    signal,
  );
  await prepareVendors(client, database, subject, signal);
  live();
  await copyProtectedCollection(
    client,
    PRICE_COLLECTION,
    prices.map((p) => ({
      id: `product-price:${publicId(p.values.id)}`,
      value: { format: "sortsys-product-price-v1", price: p },
    })),
    pricePayload,
    signal,
  );
}

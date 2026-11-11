import type { Client } from "@sortsys/v2-client";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import { VENDOR_COLLECTION, vendorPayload } from "./vendorData";

export async function prepareVendors(client: Client, database: BusinessDatabase, subject: string, signal: AbortSignal) {
  await prepareOwnerCollections(client, subject, [VENDOR_COLLECTION], signal);
  const rows = await readBusinessRows(database, "product_vendors");
  await copyProtectedCollection(client, VENDOR_COLLECTION, rows.map(vendor => ({ id: VENDOR_COLLECTION.prefix + publicId(vendor.values.id),
    value: { format: "sortsys-vendor-v1", vendor } })), vendorPayload, signal);
}

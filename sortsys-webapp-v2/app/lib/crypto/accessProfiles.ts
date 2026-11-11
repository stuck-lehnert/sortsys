import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { PRICE_COLLECTION, PRODUCT_COLLECTION } from "../data/products";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION } from "../data/addressBook";
import { VENDOR_COLLECTION } from "../data/vendorData";

export const MASTER_DATA_AREAS = { catalogue: PRODUCT_COLLECTION, customers: CUSTOMER_COLLECTION, contacts: CONTACT_COLLECTION, vendors: VENDOR_COLLECTION, prices: PRICE_COLLECTION };
export const MASTER_DATA_FIELDS = ["catalogue", "customers", "contacts", "vendors", "prices"] as const;
export type ManagedAccess = { [key in typeof MASTER_DATA_FIELDS[number]]: "none" | "read" | "write" } & { assistant: boolean };
export function managedAccess(input: unknown): ManagedAccess {
  const data = record(input, [...MASTER_DATA_FIELDS, "assistant"]);
  if (MASTER_DATA_FIELDS.some(key => !["none", "read", "write"].includes(String(data[key])))
    || typeof data.assistant !== "boolean") throw new InvalidProtectedData();
  return data as ManagedAccess;
}

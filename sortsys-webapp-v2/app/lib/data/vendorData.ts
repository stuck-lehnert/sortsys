import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";

export const VENDOR_COLLECTION: Collection = { domain: "catalog:vendors:master-data", scope: "catalog:vendors", facet: "master-data", prefix: "vendor:" };
export const VENDOR_QUERIES = new Set(["products.vendors.list", "products.vendors.get"]);
export const VENDOR_MUTATIONS = new Set(["products.vendors.create", "products.vendors.update", "products.vendors.delete"]);
export type VendorPayload = { format: "sortsys-vendor-v1"; vendor: BusinessRow };
export const VENDOR_MODEL = defineDataModel({ name: "vendors", decode: vendorPayload, tables: ["product_vendors"] });

export function vendorPayload(input: unknown, object: string): VendorPayload {
  const data = record(input, ["format", "vendor"]), vendor = decodeBusinessRow(data.vendor);
  if (data.format !== "sortsys-vendor-v1" || vendor.table !== "product_vendors" || object !== VENDOR_COLLECTION.prefix + publicId(vendor.values.id)) throw new InvalidProtectedData();
  // Stored PostgreSQL VARCHAR bounds count characters, not UTF-8 bytes. The
  // row decoder already enforces those bounds for unchanged legacy contents.
  addressId(publicId(vendor.values.id)); addressText(vendor.values.name, true); addressText(vendor.values.description, false);
  return { format: data.format, vendor };
}
export function vendorChanges(input: unknown, creating: boolean) {
  const data = partialAddressRecord(input, ["name", "description"]), values: Record<string, unknown> = {};
  if (creating || Object.hasOwn(data, "name")) values.name = addressText(data.name, true, 127);
  if (creating || Object.hasOwn(data, "description")) values.description = addressText(data.description, false, 255);
  return values;
}

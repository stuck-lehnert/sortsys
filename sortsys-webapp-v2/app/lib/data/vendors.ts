import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { buildPrefixSearch } from "../search/prefixQuery";
import { addressId, partialAddressRecord } from "./addressBook";
import { newProductRowId, publicId } from "./products";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";
import type { DuckDriver } from "./database";
import {
  VENDOR_COLLECTION,
  VENDOR_MODEL,
  VENDOR_MUTATIONS,
  vendorChanges,
  type VendorPayload,
} from "./vendorData";

function wire(payload: VendorPayload): QueryResult<"products.vendors.get"> {
  const value = payload.vendor.values;
  return {
    id: publicId(value.id),
    name: value.name as string,
    description: value.description as string | null,
    createdAt: new Date(value.created_at as string),
    modifiedAt: new Date(value.modified_at as string),
  };
}
const request = { model: VENDOR_MODEL, area: VENDOR_COLLECTION };
const vendorSearch = Symbol("vendor search");
export function createProtectedVendors(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  return {
    async query(path: string, input: unknown, limit?: number) {
      lease.live();
      const data =
        path === "products.vendors.get"
          ? record(input, ["id"])
          : partialAddressRecord(input ?? {}, ["search"]);
      if (path === "products.vendors.get") addressId(data.id);
      else if (
        path !== "products.vendors.list" ||
        (data.search != null && typeof data.search !== "string")
      )
        throw new InvalidProtectedData();
      const result = await runtime.read(
        [request],
        (view) => {
          if (path === "products.vendors.get") {
            const vendor = view.documents(request)
              .find(({ value }) => publicId(value.vendor.values.id) === data.id);
            if (!vendor) throw new InvalidProtectedData();
            return wire(vendor.value);
          }
          const search = view.derive(vendorSearch, [request], () =>
            buildPrefixSearch(
              view.documents(request).map(({ value }) => wire(value)).sort((a, b) =>
                a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
              ),
              (vendor) => [vendor.name, vendor.description],
            ),
          );
          return search(data.search as string | undefined, undefined, limit);
        },
        undefined,
        { batchDirectory: limit !== undefined },
      );
      lease.live();
      return result;
    },
    async mutate(path: string, input: unknown) {
      lease.live();
      if (!VENDOR_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path === "products.vendors.create",
        deleting = path === "products.vendors.delete";
      const data = creating
        ? null
        : record(input, deleting ? ["id"] : ["id", "data"]);
      const rawId = creating ? newProductRowId() : addressId(data!.id),
        id = VENDOR_COLLECTION.prefix + publicId(rawId);
      if (deleting) await runtime.removeStock(request, id);
      else {
        const changes = vendorChanges(creating ? input : data!.data, creating),
          now = new Date().toISOString();
        await runtime.transaction([request], (tx) => {
          if (creating)
            tx.create(request, id, {
              format: "sortsys-vendor-v1",
              vendor: {
                format: "sortsys-row-v2",
                schema: businessSchema.fingerprint,
                table: "product_vendors",
                values: {
                  id: rawId,
                  ...changes,
                  created_at: now,
                  modified_at: now,
                },
              },
            });
          else
            tx.patch(
              "product_vendors",
              { id: rawId },
              { ...changes, modified_at: now },
            );
        });
      }
      lease.live();
      return creating ? { id: publicId(rawId) } : { success: true as const };
    },
    async refresh() {
      lease.live();
      runtime.invalidate(new Set([VENDOR_COLLECTION.domain]));
    },
    close: lease.close,
  };
}

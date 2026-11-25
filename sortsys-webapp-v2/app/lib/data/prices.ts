import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { acquireDataRuntime } from "./runtime/session";
import type { DuckDriver } from "./database";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import {
  newProductRowId,
  PRICE_COLLECTION,
  PRICE_MUTATIONS,
  priceRequest,
  wirePrice,
  PRODUCT_MODEL,
  PRODUCT_COLLECTION,
  publicId,
} from "./products";
import { businessSchema } from "./schema";
import { VENDOR_COLLECTION, VENDOR_MODEL } from "./vendorData";

export function priceChanges(input: unknown, creating: boolean) {
  const data = partialAddressRecord(input, [
      "productId",
      "vendorId",
      "timestamp",
      "pricePerBaseUnit",
      "isRealPurchase",
      "comment",
    ]),
    values: Record<string, unknown> = {};
  if (creating || Object.hasOwn(data, "productId"))
    values.product_id = addressId(data.productId);
  if (creating || Object.hasOwn(data, "vendorId"))
    values.vendor_id = data.vendorId == null ? null : addressId(data.vendorId);
  if (creating || Object.hasOwn(data, "timestamp")) {
    if (
      !(data.timestamp instanceof Date) ||
      !Number.isFinite(data.timestamp.getTime())
    )
      throw new InvalidProtectedData();
    values.timestamp = data.timestamp.toISOString();
  }
  if (creating || Object.hasOwn(data, "pricePerBaseUnit")) {
    if (
      typeof data.pricePerBaseUnit !== "number" ||
      !Number.isFinite(data.pricePerBaseUnit)
    )
      throw new InvalidProtectedData();
    values.price = data.pricePerBaseUnit;
  }
  if (creating || Object.hasOwn(data, "isRealPurchase")) {
    if (typeof data.isRealPurchase !== "boolean")
      throw new InvalidProtectedData();
    values.is_real_purchase = data.isRealPurchase;
  }
  if (creating || Object.hasOwn(data, "comment"))
    values.comment = addressText(data.comment, false, 255);
  return values;
}

export function createProtectedPrices(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  return {
    async list(productId?: string) {
      lease.live();
      const values = await runtime.read([priceRequest], (view) =>
        view
          .documents(priceRequest)
          .map(({ value }) => wirePrice(value.price))
          .filter((price) => !productId || price.productId === productId)
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
      );
      lease.live();
      return values;
    },
    async mutate(path: string, input: unknown) {
      lease.live();
      if (!PRICE_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path.endsWith(".create"),
        deleting = path.endsWith(".delete"),
        data = creating
          ? null
          : record(input, deleting ? ["id"] : ["id", "data"]);
      const rawId = creating ? newProductRowId() : addressId(data!.id),
        id = PRICE_COLLECTION.prefix + publicId(rawId),
        selected = { ...priceRequest, ids: [id] };
      if (deleting) {
        await runtime.removeStock(selected, id);
        lease.live();
        return { success: true as const };
      }
      const changes = priceChanges(creating ? input : data!.data, creating),
        previous = creating
          ? null
          : await runtime.read([selected], (view) => {
              const value = view.documents(selected)[0];
              if (!value) throw new InvalidProtectedData();
              return value;
            });
      const product =
        changes.product_id != null &&
        changes.product_id !== previous?.value.price.values.product_id
          ? publicId(changes.product_id)
          : null;
      const vendor =
        changes.vendor_id != null &&
        changes.vendor_id !== previous?.value.price.values.vendor_id
          ? publicId(changes.vendor_id)
          : null;
      const productRequest = {
        model: PRODUCT_MODEL,
        area: PRODUCT_COLLECTION,
        ids: product ? [PRODUCT_COLLECTION.prefix + product] : [],
      };
      const vendorRequest = {
        model: VENDOR_MODEL,
        area: VENDOR_COLLECTION,
        ids: vendor ? [VENDOR_COLLECTION.prefix + vendor] : [],
      };
      const now = new Date().toISOString();
      await runtime.transaction(
        [
          selected,
          ...(product ? [productRequest] : []),
          ...(vendor ? [vendorRequest] : []),
        ],
        (tx) => {
          if (
            (product && !tx.documents(productRequest).length) ||
            (vendor && !tx.documents(vendorRequest).length)
          )
            throw new InvalidProtectedData();
          if (previous)
            tx.expect(selected, id, { signature: previous.signature });
          if (creating)
            tx.create(selected, id, {
              format: "sortsys-product-price-v1",
              price: {
                format: "sortsys-row-v2",
                schema: businessSchema.fingerprint,
                table: "product_price_records",
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
              "product_price_records",
              { id: rawId },
              { ...changes, modified_at: now },
            );
        },
      );
      lease.live();
      return creating ? { id: publicId(rawId) } : { success: true as const };
    },
    close: lease.close,
  };
}

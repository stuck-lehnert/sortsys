import type { Client, MutateResult } from "@sortsys/v2-client";
import {
  accountRequestFingerprint,
  InvalidProtectedData,
  record,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { uiText } from "../i18n";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { isWriteConflict, ProtectedWriteConflict } from "./atomicWrites";
import type { DuckDriver } from "./database";
import {
  newProductRowId,
  PRICE_COLLECTION,
  PRICE_MODEL,
  pricePayload,
  PRODUCT_COLLECTION,
  PRODUCT_MODEL,
  productChanges,
  type ProductPayload,
  productPayload,
  publicId,
} from "./products";
import { acquireDataRuntime } from "./runtime/session";
import { defineDataModel } from "./runtime/model";
import { type Collection, required } from "./protectedObjects";
import { businessSchema } from "./schema";
import { VENDOR_COLLECTION, VENDOR_MODEL } from "./vendorData";

export const PRICE_IMPORT_MUTATION = "products.priceImports.apply";
const RECEIPTS: Collection = { ...PRICE_COLLECTION, prefix: "price-import:" };
type Output = MutateResult<typeof PRICE_IMPORT_MUTATION>;
type Receipt = Output & {
  format: "sortsys-price-import-v1";
  requestId: string;
  author: string;
  requestHash: string;
  createdAt: string;
};

function conversions(input: unknown, baseUnit: string): Record<string, number> {
  if (input == null) return {};
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Object.keys(input).length > 64
  )
    throw new InvalidProtectedData();
  const seen = new Set([baseUnit.toLowerCase()]),
    result: [string, number][] = [];
  for (const [name, factor] of Object.entries(input).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const unit = addressText(name, true, 32)!;
    if (
      ["__proto__", "constructor", "prototype"].includes(unit) ||
      seen.has(unit.toLowerCase()) ||
      typeof factor !== "number" ||
      !Number.isFinite(factor) ||
      factor <= 0
    )
      throw new InvalidProtectedData();
    seen.add(unit.toLowerCase());
    result.push([unit, factor]);
  }
  return Object.fromEntries(result);
}
export function priceImportInput(input: unknown) {
  const data = partialAddressRecord(input, [
    "requestId",
    "vendorId",
    "effectiveAt",
    "isRealPurchase",
    "rows",
  ]);
  const requestId = data.requestId ?? crypto.randomUUID();
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(requestId) ||
    !(data.effectiveAt instanceof Date) ||
    !Number.isFinite(data.effectiveAt.getTime()) ||
    typeof data.isRealPurchase !== "boolean" ||
    !Array.isArray(data.rows) ||
    !data.rows.length ||
    data.rows.length > 20_000
  )
    throw new InvalidProtectedData();
  return {
    requestId,
    vendorId: publicId(addressId(data.vendorId)),
    effectiveAt: data.effectiveAt.toISOString(),
    isRealPurchase: data.isRealPurchase,
    rows: data.rows.map((input) => {
      const row = partialAddressRecord(input, [
        "productId",
        "productName",
        "brand",
        "description",
        "baseUnit",
        "otherUnits",
        "pricePerBaseUnit",
        "comment",
      ]);
      const productId =
        row.productId == null ? null : publicId(addressId(row.productId));
      const productName = addressText(row.productName, true, 255)!,
        baseUnit = addressText(row.baseUnit, true, 8)!;
      if (
        typeof row.pricePerBaseUnit !== "number" ||
        !Number.isFinite(row.pricePerBaseUnit) ||
        row.pricePerBaseUnit < 0
      )
        throw new InvalidProtectedData();
      return {
        productId,
        productName,
        baseUnit,
        brand: addressText(row.brand, false, productId ? Infinity : 127),
        description: addressText(
          row.description,
          false,
          productId ? Infinity : 511,
        ),
        otherUnits: productId ? {} : conversions(row.otherUnits, baseUnit),
        pricePerBaseUnit: row.pricePerBaseUnit,
        comment: addressText(row.comment, false, 255),
      };
    }),
  };
}
export function priceImportReceipt(input: unknown): Receipt {
  const data = record(input, [
    "format",
    "requestId",
    "author",
    "requestHash",
    "createdAt",
    "createdProducts",
    "createdPriceRecords",
  ]);
  if (
    data.format !== "sortsys-price-import-v1" ||
    typeof data.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(data.requestId) ||
    typeof data.author !== "string" ||
    !data.author.startsWith("user:") ||
    typeof data.createdAt !== "string" ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    new Date(data.createdAt).toISOString() !== data.createdAt ||
    !Number.isInteger(data.createdProducts) ||
    !Number.isInteger(data.createdPriceRecords) ||
    (data.createdProducts as number) < 0 ||
    (data.createdPriceRecords as number) < 1 ||
    (data.createdPriceRecords as number) > 20_000 ||
    (data.createdProducts as number) > (data.createdPriceRecords as number)
  )
    throw new InvalidProtectedData();
  addressId(data.author.slice(5));
  sized(data.requestHash as string, 32);
  return data as Receipt;
}

/** The receipt contains a keyed fingerprint, not a public hash of product
 * descriptions. Price-only readers cannot test guesses about catalogue text. */
export async function priceImportFingerprint(
  dataKey: CryptoKey,
  tenant: string,
  subject: string,
  input: ReturnType<typeof priceImportInput>,
): Promise<string> {
  return accountRequestFingerprint(
    dataKey,
    "sortsys/price-import-request/v1",
    tenant,
    subject,
    input,
  );
}

const RECEIPT_MODEL = defineDataModel({
  name: "price-import-receipts",
  tables: [],
  decode(value: unknown, id: string) {
    const receipt = priceImportReceipt(value);
    if (
      id !== `${RECEIPTS.prefix}${receipt.author.slice(5)}:${receipt.requestId}`
    )
      throw new InvalidProtectedData();
    return receipt;
  },
  opened(value, object) {
    if (
      object.envelope.revision !== "0" &&
      object.envelope.author !== value.author
    )
      throw new InvalidProtectedData();
    return value;
  },
});

/** The business command edits ordinary models. The shared runtime validates,
 * encrypts, stages and atomically publishes the products, prices and receipt. */
export async function applyProtectedPriceImport(
  client: Client,
  input: unknown,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<Output> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  try {
    const data = priceImportInput(input),
      session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
    lease.live();
    const subject = `user:${session.user.id}`,
      object = `${RECEIPTS.prefix}${session.user.id}:${data.requestId}`;
    const requestHash = await priceImportFingerprint(
      account.dataKey,
      account.tenant,
      subject,
      data,
    );
    lease.live();
    const receiptRequest = {
      model: RECEIPT_MODEL,
      area: RECEIPTS,
      ids: [object],
    };
    const productRequest = { model: PRODUCT_MODEL, area: PRODUCT_COLLECTION };
    const vendorRequest = {
      model: VENDOR_MODEL,
      area: VENDOR_COLLECTION,
      ids: [VENDOR_COLLECTION.prefix + data.vendorId],
    };
    const priceRequest = {
      model: PRICE_MODEL,
      area: PRICE_COLLECTION,
      ids: [],
    };
    function saved(receipt: Receipt | undefined): Output | null {
      if (!receipt) return null;
      if (
        receipt.author !== subject ||
        receipt.requestId !== data.requestId ||
        receipt.requestHash !== requestHash
      )
        throw new InvalidProtectedData();
      return {
        createdProducts: receipt.createdProducts,
        createdPriceRecords: receipt.createdPriceRecords,
      };
    }
    const readReceipt = () =>
      runtime.read([receiptRequest], (view) =>
        saved(view.documents(receiptRequest)[0]?.value),
      );
    const previous = await readReceipt();
    if (previous) return previous;
    try {
      const result = await runtime.transaction(
        [productRequest, vendorRequest, priceRequest, receiptRequest],
        (tx) => {
          lease.live();
          const previous = saved(tx.documents(receiptRequest)[0]?.value);
          if (previous) return previous;
          tx.require(priceRequest, "create");
          if (!tx.documents(vendorRequest).length) {
            throw new InvalidProtectedData();
          }
          const catalogue = tx
              .documents(productRequest)
              .map((document) => document.value),
            byId = new Map(
              catalogue.map((row) => [publicId(row.product.values.id), row]),
            );
          if (data.rows.some((row) => row.productId === null)) {
            tx.require(productRequest, "create");
          }
          const created: { id: string; value: ProductPayload }[] = [],
            prices: { id: string; value: ReturnType<typeof pricePayload> }[] =
              [];
          let next = catalogue.reduce(
            (max, row) => Math.max(max, Number(row.product.values.custom_id)),
            0,
          );
          const now = new Date().toISOString();
          for (const row of data.rows) {
            lease.live();
            let target: ProductPayload;
            if (row.productId) {
              const found = byId.get(row.productId);
              if (!found) throw new InvalidProtectedData();
              target = found;
              if (row.baseUnit !== target.product.values.base_unit) {
                throw new Error(
                  uiText(
                    "Die Basiseinheit eines Produkts hat sich geändert. Bitte die Zuordnung erneut prüfen.",
                    "A product's base unit changed. Check its mapping again.",
                  ),
                );
              }
            } else {
              if (next >= 2147483647) throw new InvalidProtectedData();
              const rawId = newProductRowId(),
                id = PRODUCT_COLLECTION.prefix + publicId(rawId);
              target = productPayload(
                {
                  format: "sortsys-product-v1",
                  categories: [],
                  product: {
                    format: "sortsys-row-v2",
                    schema: businessSchema.fingerprint,
                    table: "products",
                    values: {
                      id: rawId,
                      ...productChanges(
                        {
                          customId: ++next,
                          name: row.productName,
                          brand: row.brand,
                          description: row.description,
                          baseUnit: row.baseUnit,
                          otherUnits: row.otherUnits,
                        },
                        true,
                      ),
                      created_at: now,
                      modified_at: now,
                    },
                  },
                },
                id,
              );
              created.push({ id, value: target });
            }
            const rawPrice = newProductRowId(),
              id = PRICE_COLLECTION.prefix + publicId(rawPrice);
            prices.push({
              id,
              value: pricePayload(
                {
                  format: "sortsys-product-price-v1",
                  price: {
                    format: "sortsys-row-v2",
                    schema: businessSchema.fingerprint,
                    table: "product_price_records",
                    values: {
                      id: rawPrice,
                      product_id: target.product.values.id,
                      vendor_id: addressId(data.vendorId),
                      price: row.pricePerBaseUnit,
                      timestamp: data.effectiveAt,
                      is_real_purchase: data.isRealPurchase,
                      comment: row.comment,
                      created_at: now,
                      modified_at: now,
                    },
                  },
                },
                id,
              ),
            });
          }
          tx.createMany(productRequest, created);
          tx.createMany(priceRequest, prices);
          const result = {
            createdProducts: created.length,
            createdPriceRecords: prices.length,
          };
          tx.create(
            receiptRequest,
            object,
            priceImportReceipt({
              format: "sortsys-price-import-v1",
              requestId: data.requestId,
              author: subject,
              requestHash,
              createdAt: now,
              ...result,
            }),
          );
          return result;
        },
      );
      lease.live();
      return result;
    } catch (error) {
      lease.live();
      runtime.revalidate();
      try {
        const receipt = await readReceipt();
        if (receipt) return receipt;
      } catch {
        lease.live();
      }
      if (isWriteConflict(error)) throw new ProtectedWriteConflict();
      throw error;
    }
  } finally {
    lease.close();
  }
}

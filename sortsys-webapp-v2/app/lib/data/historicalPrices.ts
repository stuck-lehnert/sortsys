import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { publicId } from "./products";
import { timestampMicros } from "./timestamps";
import {
  effectiveHistory,
  indexEffectiveHistory,
  type EffectiveEntry,
} from "./effectiveHistory";

/** Compare original instants before Date projection loses microseconds.
 * Equal instants use numeric IDs, independent of source iteration order. */
function priceEntries(
  rows: readonly BusinessRow[],
): EffectiveEntry<BusinessRow>[] {
  const entries: EffectiveEntry<BusinessRow>[] = [];
  for (const input of rows) {
    const row = decodeBusinessRow(input);
    if (row.table !== "product_price_records") {
      throw new InvalidProtectedData();
    }
    entries.push({
      group: publicId(row.values.product_id),
      instant: timestampMicros(row.values.timestamp as string),
      id: BigInt(row.values.id as string),
      value: row,
    });
  }
  return entries;
}
export function historicalPrices(
  rows: readonly BusinessRow[],
  cutoff: bigint,
  futureFallback: "earliest" | "none",
): Map<string, BusinessRow> {
  return effectiveHistory(priceEntries(rows), cutoff, futureFallback);
}
export function indexHistoricalPrices(rows: readonly BusinessRow[]) {
  return indexEffectiveHistory(priceEntries(rows));
}
export function wireHistoricalPrice(row: BusinessRow) {
  const values = row.values;
  return {
    id: publicId(values.id),
    productId: publicId(values.product_id),
    vendorId: values.vendor_id === null ? null : publicId(values.vendor_id),
    timestamp: new Date(values.timestamp as string),
    price: values.price as number,
    isRealPurchase: values.is_real_purchase as boolean,
    comment: values.comment as string | null,
  };
}

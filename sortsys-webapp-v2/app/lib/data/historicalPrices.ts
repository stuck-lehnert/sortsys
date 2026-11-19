import type { BusinessRow } from "./rowCodec";
import { priceRequest, publicId } from "./products";
import type { DataView } from "./runtime/runtime";
import { timestampMicros } from "./timestamps";
import { indexEffectiveHistory } from "./effectiveHistory";

/** Compare original instants before Date projection loses microseconds.
 * Equal instants use numeric IDs, independent of source iteration order. */
export function indexHistoricalPrices(rows: readonly BusinessRow[]) {
  return indexEffectiveHistory(
    rows.map((row) => ({
      group: publicId(row.values.product_id),
      instant: timestampMicros(row.values.timestamp as string),
      id: BigInt(row.values.id as string),
      value: row,
    })),
  );
}
export type HistoricalPriceLookup = ReturnType<typeof indexHistoricalPrices>;

const priceIndex = Symbol("historical product prices");

export function historicalPriceIndex(view: DataView) {
  return view.derive(priceIndex, [priceRequest], () =>
    indexHistoricalPrices(
      view.documents(priceRequest).map(({ value }) => value.price),
    ),
  );
}

import type { BusinessRow } from "./rowCodec";

export function copyCommercialRows(
  rows: readonly BusinessRow[],
): BusinessRow[] {
  return rows.map((row) => ({ ...row, values: { ...row.values } }));
}

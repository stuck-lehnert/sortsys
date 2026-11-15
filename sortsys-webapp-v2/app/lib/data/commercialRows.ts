import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";

export function commercialRow(
  table: string,
  values: Record<string, unknown>,
): BusinessRow {
  return decodeBusinessRow({
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table,
    values,
  });
}

export function copyCommercialRows(
  rows: readonly BusinessRow[],
): BusinessRow[] {
  return rows.map((row) => ({ ...row, values: { ...row.values } }));
}

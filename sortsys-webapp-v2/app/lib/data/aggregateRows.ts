import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";

/** Validate aggregate membership before projecting rows into the shared DB.
 * A valid row schema alone does not bind a child to its enclosing document. */
export function aggregateRows(
  input: unknown,
  table: string,
  parentColumn: string,
  parent: unknown,
): BusinessRow[] {
  if (!Array.isArray(input) || input.length > 10000)
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  return input.map((value) => {
    const row = decodeBusinessRow(value);
    if (row.table !== table) throw new InvalidProtectedData();
    const id = publicId(row.values.id);
    addressId(id);
    if (row.values[parentColumn] !== parent || seen.has(id))
      throw new InvalidProtectedData();
    seen.add(id);
    return row;
  });
}

/** Replacement lists retain explicit line identities. Never associate hidden
 * fields with a new line merely because it occupies the same array index. */
export function existingAggregateRows(
  rows: readonly BusinessRow[],
  changes: readonly { id?: string }[],
): Map<string, BusinessRow> {
  const previous = new Map(rows.map((row) => [publicId(row.values.id), row])),
    seen = new Set<string>();
  for (const change of changes)
    if (change.id !== undefined) {
      addressId(change.id);
      if (!previous.has(change.id) || seen.has(change.id))
        throw new InvalidProtectedData();
      seen.add(change.id);
    }
  return previous;
}

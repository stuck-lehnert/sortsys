import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "./database";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { insertTableRows } from "./rowInsert";
import {
  assertUniqueIndexes,
  checkExpression,
  missingReference,
  primaryColumns,
  quoted,
  tableDefinition,
  type BusinessTable,
} from "./schema";

/** Complete projections can check each constraint over the entire table. */
export async function projectionViolation(
  tx: BusinessTransaction,
  table: BusinessTable,
  deferred: ReadonlySet<string>,
): Promise<"check" | "reference" | null> {
  if (table.constraints.some((constraint) => constraint.kind === "c")) {
    const invalid = await tx.query(
      `SELECT 1 FROM ${quoted(table.name)} WHERE NOT (${checkExpression(table)}) LIMIT 1`,
    );
    if (invalid.rows.length) return "check";
  }
  try {
    await assertUniqueIndexes(tx, table);
  } catch {
    return "check";
  }
  for (const key of table.constraints) {
    if (key.kind !== "f" || deferred.has(key.referencedTable!)) continue;
    // MATCH SIMPLE skips a composite reference if any component is NULL.
    const present = key.columns.map(
      (column) => `source.${quoted(column)} IS NOT NULL`,
    );
    const violation = [...present, missingReference(key)].join(" AND ");
    const missing = await tx.query(
      `SELECT 1 FROM ${quoted(table.name)} source WHERE ${violation} LIMIT 1`,
    );
    if (missing.rows.length) return "reference";
  }
  return null;
}

/** Complete rows used during migration/recovery. A batch is checked only after
 * all its rows are present, so parent/child ordering cannot break valid input.
 * Partial, facet-specific reads need a public reference resolver instead. */
export async function projectCompleteRows(
  database: BusinessDatabase,
  inputs: Iterable<unknown>,
): Promise<void> {
  await projectFacetRows(database, inputs, new Set());
}

/** An independently keyed facet cannot check another facet's private rows.
 * Only explicitly named external tables may be deferred. Internal references,
 * CHECKs, primary keys and uniqueness still run in this local transaction. */
export async function projectFacetRows(
  database: BusinessDatabase,
  inputs: Iterable<unknown>,
  deferred: ReadonlySet<string>,
): Promise<void> {
  const groups = new Map<string, BusinessRow["values"][]>();
  for (const input of inputs) {
    const { table, values } = decodeBusinessRow(input);
    const group = groups.get(table);
    if (group) group.push(values);
    else groups.set(table, [values]);
  }
  try {
    await database.transaction(async (tx) => {
      for (const [name, values] of groups) {
        const table = tableDefinition(name);
        const key = primaryColumns(table);
        // Reject competing source rows before DuckDB can silently drop one.
        const ids = new Set(
          values.map((row) => JSON.stringify(key.map((column) => row[column]))),
        );
        if (ids.size !== values.length) throw new InvalidProtectedData();
        await insertTableRows(tx, table, values, "upsert");
      }
      for (const name of groups.keys()) {
        if (await projectionViolation(tx, tableDefinition(name), deferred)) {
          throw new InvalidProtectedData();
        }
      }
    });
  } catch {
    throw new InvalidProtectedData();
  }
}

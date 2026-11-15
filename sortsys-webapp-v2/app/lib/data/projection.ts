import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "./database";
import { decodeBusinessRow, rowParameters } from "./rowCodec";
import type { BusinessRow } from "./rowCodec";
import {
  assertProjectedChecks,
  assertUniqueIndexes,
  primaryColumns,
  quoted,
  tableDefinition,
} from "./schema";

async function put(tx: BusinessTransaction, row: BusinessRow): Promise<void> {
  const table = tableDefinition(row.table);
  const columns = table.columns.map((c) => c.name);
  const key = primaryColumns(table);
  const updates = columns.filter((c) => !key.includes(c));
  await tx.query(
    `INSERT INTO ${quoted(table.name)}(${columns.map(quoted).join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")}) ON CONFLICT(${key.map(quoted).join(",")}) ${updates.length ? `DO UPDATE SET ${updates.map((c) => `${quoted(c)}=excluded.${quoted(c)}`).join(",")}` : "DO NOTHING"}`,
    rowParameters(row),
  );
}

async function references(
  tx: BusinessTransaction,
  row: BusinessRow,
  deferred: ReadonlySet<string>,
): Promise<void> {
  for (const constraint of tableDefinition(row.table).constraints.filter(
    (c) => c.kind === "f",
  )) {
    if (constraint.columns.some((c) => row.values[c] === null)) continue; // SQL MATCH SIMPLE
    if (deferred.has(constraint.referencedTable!)) continue;
    const target = tableDefinition(constraint.referencedTable!);
    const result = await tx.query(
      `SELECT 1 AS found FROM ${quoted(target.name)} WHERE ${constraint.referencedColumns.map((c, index) => `${quoted(c)}=$${index + 1}`).join(" AND ")} LIMIT 1`,
      constraint.columns.map((c) => row.values[c]),
    );
    if (result.rows.length !== 1) throw new InvalidProtectedData();
  }
}

/** Complete rows used during migration/recovery. A batch is checked only after
 * all its rows are present, so parent/child ordering cannot break valid input.
 * Partial, facet-specific reads need a public reference resolver instead. */
export async function projectCompleteRows(
  database: BusinessDatabase,
  inputs: unknown[],
): Promise<void> {
  await projectFacetRows(database, inputs, new Set());
}

/** An independently keyed facet cannot check another facet's private rows.
 * Only explicitly named external tables may be deferred. Internal references,
 * CHECKs, primary keys and uniqueness still run in this local transaction. */
export async function projectFacetRows(
  database: BusinessDatabase,
  inputs: unknown[],
  deferred: ReadonlySet<string>,
): Promise<void> {
  if (inputs.length > 10_000) throw new InvalidProtectedData();
  const rows = inputs.map(decodeBusinessRow);
  try {
    await database.transaction(async (tx) => {
      for (const row of rows) await put(tx, row);
      for (const row of rows) {
        await assertProjectedChecks(tx, tableDefinition(row.table), row.values);
        await references(tx, row, deferred);
      }
      for (const name of new Set(rows.map((row) => row.table)))
        await assertUniqueIndexes(tx, tableDefinition(name));
    });
  } catch {
    throw new InvalidProtectedData();
  }
}

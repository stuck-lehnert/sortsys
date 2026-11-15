import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "../database";
import {
  assertUniqueIndexes,
  primaryColumns,
  quoted,
  tableDefinition,
  type BusinessConstraint,
  type BusinessTable,
} from "../schema";
import type { DataDocument } from "./model";
import type { DataRecord } from "./rows";

export type DataTables = Map<string, Map<string, DataRecord>>;

function needsConstraint(
  row: DataRecord,
  constraint: BusinessConstraint,
  external: ReadonlyMap<DataDocument<unknown>, ReadonlySet<string>>,
): boolean {
  // Unavailable private fields cannot be validated as observed SQL NULLs.
  if (constraint.columns.some((column) => !Object.hasOwn(row.values, column)))
    return false;
  if (constraint.kind === "c") return true;
  if (constraint.columns.some((column) => row.values[column] === null))
    return false;
  const owners = row.owners.get(constraint.columns[0]!) ?? [];
  const externalOnly =
    owners.length > 0 &&
    owners.every((owner) =>
      external.get(owner.document)?.has(constraint.referencedTable!),
    );
  return !externalOnly;
}

async function validateConstraint(
  tx: BusinessTransaction,
  table: BusinessTable,
  constraint: BusinessConstraint,
  rows: readonly DataRecord[],
): Promise<void> {
  if (rows.length === 0) return;
  let violation: string;
  if (constraint.kind === "c") {
    if (!constraint.expression.startsWith("CHECK ("))
      throw new InvalidProtectedData();
    violation = `((${constraint.expression.slice(6)}) IS FALSE)`;
  } else {
    const target = tableDefinition(constraint.referencedTable!);
    const match = constraint.columns
      .map(
        (column, index) =>
          `target.${quoted(constraint.referencedColumns[index]!)}=source.${quoted(column)}`,
      )
      .join(" AND ");
    violation = `NOT EXISTS(SELECT 1 FROM ${quoted(target.name)} target WHERE ${match})`;
  }
  const keys = primaryColumns(table);
  const batchSize = Math.min(128, Math.max(1, Math.floor(4096 / keys.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const selected = rows.slice(offset, offset + batchSize);
    const parameters = selected.flatMap((row) =>
      keys.map((key) => row.values[key]),
    );
    const predicates = selected.map((_, rowIndex) => {
      const columns = keys.map(
        (key, columnIndex) =>
          `source.${quoted(key)}=$${rowIndex * keys.length + columnIndex + 1}`,
      );
      return `(${columns.join(" AND ")})`;
    });
    const invalid = await tx.query(
      `SELECT 1 FROM ${quoted(table.name)} source WHERE (${predicates.join(" OR ")}) AND (${violation}) LIMIT 1`,
      parameters,
    );
    if (invalid.rows.length > 0) throw new InvalidProtectedData();
  }
}

/** The in-memory availability map remains authoritative. SQL NULL is only a
 * projection placeholder; callers must declare every field their SQL reads. */
export async function projectRuntimeRows(
  database: BusinessDatabase,
  previous: DataTables,
  tables: DataTables,
  documents: Iterable<DataDocument<unknown>>,
): Promise<void> {
  const external = new Map<DataDocument<unknown>, Set<string>>();
  for (const document of documents)
    external.set(document, new Set(document.model.externalReferences));
  await database.transaction(async (tx) => {
    for (const name of new Set([...previous.keys(), ...tables.keys()]))
      await tx.exec(`DELETE FROM ${quoted(name)}`);
    for (const [name, rows] of tables) {
      const table = tableDefinition(name),
        columns = table.columns.map((column) => column.name);
      const values = [...rows.values()],
        batchSize = Math.min(
          128,
          Math.max(1, Math.floor(4096 / columns.length)),
        );
      for (let offset = 0; offset < values.length; offset += batchSize) {
        const batch = values.slice(offset, offset + batchSize),
          parameters = batch.flatMap((row) =>
            columns.map((column) =>
              Object.hasOwn(row.values, column) ? row.values[column] : null,
            ),
          );
        await tx.query(
          `INSERT INTO ${quoted(name)}(${columns.map(quoted).join(",")}) VALUES${batch.map((_, row) => `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(",")})`).join(",")}`,
          parameters,
        );
      }
    }
    for (const [name, rows] of tables) {
      const table = tableDefinition(name);
      for (const constraint of table.constraints) {
        if (constraint.kind !== "c" && constraint.kind !== "f") continue;
        const selected = [...rows.values()].filter((row) =>
          needsConstraint(row, constraint, external),
        );
        await validateConstraint(tx, table, constraint, selected);
      }
      // Constraint fields that are present keep their usual SQL semantics.
      // Unknown fields never count as an observed NULL in the public row API.
      await assertUniqueIndexes(tx, table);
    }
  });
}

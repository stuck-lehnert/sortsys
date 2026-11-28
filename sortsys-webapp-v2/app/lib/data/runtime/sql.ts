import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "../database";
import { insertTableRows } from "../rowInsert";
import {
  assertUniqueIndexes,
  checkOperand,
  missingReference,
  primaryColumns,
  quoted,
  tableDefinition,
  type BusinessConstraint,
  type BusinessTable,
} from "../schema";
import type { DataRecord } from "./rows";

export type DataTables = Map<string, Map<string, DataRecord>>;

function needsConstraint(
  row: DataRecord,
  constraint: BusinessConstraint,
): boolean {
  // Unavailable private fields cannot be validated as observed SQL NULLs.
  if (constraint.columns.some((column) => !Object.hasOwn(row.values, column)))
    return false;
  if (constraint.kind === "c") return true;
  if (constraint.columns.some((column) => row.values[column] === null))
    return false;

  // Every owner comes from the documents that built this projection.
  const owners = row.owners.get(constraint.columns[0]!) ?? [];
  const externalOnly =
    owners.length > 0 &&
    owners.every((owner) =>
      owner.document.model.externalReferences?.includes(
        constraint.referencedTable!,
      ),
    );
  return !externalOnly;
}

async function validateConstraint(
  tx: BusinessTransaction,
  table: BusinessTable,
  constraint: BusinessConstraint,
  rows: readonly DataRecord[],
  allRows: boolean,
): Promise<void> {
  if (rows.length === 0) return;

  const violation =
    constraint.kind === "c"
      ? `(${checkOperand(constraint)} IS FALSE)`
      : missingReference(constraint);
  const source = `SELECT 1 FROM ${quoted(table.name)} source`;
  if (allRows) {
    // This table was just rebuilt from these exact rows. No primary-key
    // predicates are needed when every row is eligible for the constraint.
    const invalid = await tx.query(`${source} WHERE ${violation} LIMIT 1`);
    if (invalid.rows.length > 0) throw new InvalidProtectedData();
    return;
  }

  const keys = primaryColumns(table);
  const batchSize = Math.min(128, Math.max(1, Math.floor(4096 / keys.length)));
  for (const selected of arrayBatches(rows, batchSize)) {
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
      `${source} WHERE (${predicates.join(" OR ")}) AND (${violation}) LIMIT 1`,
      parameters,
    );
    if (invalid.rows.length > 0) throw new InvalidProtectedData();
  }
}

/** The in-memory availability map remains authoritative. SQL NULL is only a
 * projection placeholder; callers must declare every field their SQL reads. */
export function projectRuntimeRows(
  database: BusinessDatabase,
  previous: DataTables,
  tables: DataTables,
  options?: { rollback?: boolean },
): Promise<void> {
  return database.transaction(async (tx) => {
    const names = new Set([...previous.keys(), ...tables.keys()]);
    if (names.size) {
      const deletes = [...names].map((name) => `DELETE FROM ${quoted(name)}`);
      await tx.exec(deletes.join(";\n"));
    }
    for (const [name, rows] of tables) {
      await insertTableRows(
        tx,
        tableDefinition(name),
        [...rows.values()].map((row) => row.values),
      );
    }
    for (const [name, rows] of tables) {
      const table = tableDefinition(name);
      for (const constraint of table.constraints) {
        if (constraint.kind !== "c" && constraint.kind !== "f") continue;
        const selected = [...rows.values()].filter((row) =>
          needsConstraint(row, constraint),
        );
        await validateConstraint(
          tx,
          table,
          constraint,
          selected,
          selected.length === rows.size,
        );
      }
      // Constraint fields that are present keep their usual SQL semantics.
      // Unknown fields never count as an observed NULL in the public row API.
      await assertUniqueIndexes(tx, table);
    }
  }, options);
}

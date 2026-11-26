import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "../database";
import { insertTableRows } from "../rowInsert";
import {
  assertUniqueIndexes,
  missingReference,
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
    violation = missingReference(constraint);
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
      `SELECT 1 FROM ${quoted(table.name)} source WHERE (${predicates.join(" OR ")}) AND (${violation}) LIMIT 1`,
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
  documents: Iterable<DataDocument<unknown>>,
  options?: { rollback?: boolean },
): Promise<void> {
  const external = new Map<DataDocument<unknown>, Set<string>>();
  for (const document of documents)
    external.set(document, new Set(document.model.externalReferences));
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
          needsConstraint(row, constraint, external),
        );
        await validateConstraint(tx, table, constraint, selected);
      }
      // Constraint fields that are present keep their usual SQL semantics.
      // Unknown fields never count as an observed NULL in the public row API.
      await assertUniqueIndexes(tx, table);
    }
  }, options);
}

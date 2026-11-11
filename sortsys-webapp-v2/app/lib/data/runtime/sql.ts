import { InvalidProtectedData } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "../database";
import { assertUniqueIndexes, quoted, tableDefinition } from "../schema";
import type { DataDocument } from "./model";
import type { DataRecord } from "./rows";

export type DataTables = Map<string, Map<string, DataRecord>>;
/** The in-memory availability map remains authoritative. SQL NULL is only a
 * projection placeholder; callers must declare every field their SQL reads. */
export async function projectRuntimeRows(database: BusinessDatabase, previous: DataTables, tables: DataTables, documents: Iterable<DataDocument<unknown>>): Promise<void> {
  const external = new Map<DataDocument<unknown>, Set<string>>();
  for (const document of documents) external.set(document, new Set(document.model.externalReferences));
  await database.transaction(async tx => {
    for (const name of new Set([...previous.keys(), ...tables.keys()])) await tx.exec(`DELETE FROM ${quoted(name)}`);
    for (const [name, rows] of tables) {
      const table = tableDefinition(name), columns = table.columns.map(column => column.name);
      const values = [...rows.values()], batchSize = Math.min(128, Math.max(1, Math.floor(4096 / columns.length)));
      for (let offset = 0; offset < values.length; offset += batchSize) {
        const batch = values.slice(offset, offset + batchSize), parameters = batch.flatMap(row => columns.map(column => Object.hasOwn(row.values, column) ? row.values[column] : null));
        await tx.query(`INSERT INTO ${quoted(name)}(${columns.map(quoted).join(",")}) VALUES${batch.map((_, row) => `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(",")})`).join(",")}`, parameters);
      }
    }
    for (const [name, rows] of tables) {
      const table = tableDefinition(name);
      for (const row of rows.values()) for (const constraint of table.constraints) {
        if (constraint.kind !== "c" && constraint.kind !== "f") continue;
        // A constraint involving an unavailable private field cannot be proved.
        if (constraint.columns.some(column => !Object.hasOwn(row.values, column))) continue;
        if (constraint.kind === "c") {
          if (!constraint.expression.startsWith("CHECK (")) throw new InvalidProtectedData();
          const result = await tx.query<{ accepted: boolean }>(`SELECT ((${constraint.expression.slice(6)}) IS NOT FALSE) AS accepted FROM ${quoted(name)} WHERE ${table.constraints.find(c => c.kind === "p")!.columns.map((column, index) => `${quoted(column)}=$${index + 1}`).join(" AND ")}`, table.constraints.find(c => c.kind === "p")!.columns.map(column => row.values[column]));
          if (result.rows[0]?.accepted !== true) throw new InvalidProtectedData();
        } else {
          if (constraint.columns.some(column => row.values[column] === null)) continue;
          const owners = row.owners.get(constraint.columns[0]!) ?? [];
          if (owners.length && owners.every(owner => external.get(owner.document)?.has(constraint.referencedTable!))) continue;
          const target = tableDefinition(constraint.referencedTable!);
          const result = await tx.query(`SELECT 1 FROM ${quoted(target.name)} WHERE ${constraint.referencedColumns.map((column, index) => `${quoted(column)}=$${index + 1}`).join(" AND ")} LIMIT 1`, constraint.columns.map(column => row.values[column]));
          if (!result.rows.length) throw new InvalidProtectedData();
        }
      }
      // Constraint fields that are present keep their usual SQL semantics.
      // Unknown fields never count as an observed NULL in the public row API.
      await assertUniqueIndexes(tx, table);
    }
  });
}

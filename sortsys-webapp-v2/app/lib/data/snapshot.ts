import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "./database";
import { projectionViolation } from "./projection";
import { decodeBusinessRow } from "./rowCodec";
import { insertTableRows } from "./rowInsert";
import { businessSchema, quoted, tableDefinition } from "./schema";

export class SnapshotVerificationError extends InvalidProtectedData {
  constructor(
    readonly stage: "decode" | "insert" | "check" | "reference" | "source",
    readonly table?: string,
  ) {
    super();
    this.name = "SnapshotVerificationError";
  }
}

async function validateSnapshot(tx: BusinessTransaction): Promise<void> {
  const deferred = new Set<string>();
  for (const table of businessSchema.tables) {
    const stage = await projectionViolation(tx, table, deferred);
    if (stage) throw new SnapshotVerificationError(stage, table.name);
  }
}

/** Hydrate an empty private database atomically. Foreign keys are checked after
 * all tables, including cyclic references, have arrived. Duplicate source keys
 * fail instead of silently replacing an earlier source row. */
export async function projectCompleteSnapshot(
  database: BusinessDatabase,
  source: AsyncIterable<unknown>,
  signal: AbortSignal,
): Promise<bigint> {
  try {
    return await database.transaction(async (tx) => {
      for (const table of businessSchema.tables) {
        if (
          (await tx.query(`SELECT 1 FROM ${quoted(table.name)} LIMIT 1`)).rows
            .length
        )
          throw new InvalidProtectedData();
      }
      let count = 0n;
      for await (const input of source) {
        if (signal.aborted) throw new InvalidProtectedData();
        let row;
        try {
          row = decodeBusinessRow(input);
        } catch {
          const name =
            input && typeof input === "object" && "table" in input
              ? input.table
              : undefined;
          throw new SnapshotVerificationError(
            "decode",
            businessSchema.tables.some((t) => t.name === name)
              ? String(name)
              : undefined,
          );
        }
        const table = tableDefinition(row.table);
        try {
          await insertTableRows(tx, table, [row.values]);
        } catch {
          throw new SnapshotVerificationError("insert", table.name);
        }
        count++;
      }
      if (signal.aborted) throw new InvalidProtectedData();
      await validateSnapshot(tx);
      if (signal.aborted) throw new InvalidProtectedData();
      return count;
    });
  } catch (error) {
    if (error instanceof SnapshotVerificationError) throw error;
    throw new SnapshotVerificationError("source");
  }
}

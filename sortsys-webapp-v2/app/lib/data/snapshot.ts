import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, BusinessTransaction } from "./database";
import { decodeBusinessRow, rowParameters } from "./rowCodec";
import {
  assertUniqueIndexes,
  businessSchema,
  checkExpression,
  quoted,
} from "./schema";

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
  for (const table of businessSchema.tables) {
    const invalid = await tx.query(
      `SELECT 1 FROM ${quoted(table.name)} WHERE NOT (${checkExpression(table)}) LIMIT 1`,
    );
    if (invalid.rows.length)
      throw new SnapshotVerificationError("check", table.name);
    try {
      await assertUniqueIndexes(tx, table);
    } catch {
      throw new SnapshotVerificationError("check", table.name);
    }
    for (const key of table.constraints.filter((c) => c.kind === "f")) {
      if (!key.referencedTable) throw new InvalidProtectedData();
      const required = key.columns
        .map((c) => `source.${quoted(c)} IS NOT NULL`)
        .join(" AND ");
      const predicate = key.columns
        .map(
          (c, index) =>
            `target.${quoted(key.referencedColumns[index]!)}=source.${quoted(c)}`,
        )
        .join(" AND ");
      const missing = await tx.query(
        `SELECT 1 FROM ${quoted(table.name)} source WHERE ${required} AND NOT EXISTS(SELECT 1 FROM ${quoted(key.referencedTable)} target WHERE ${predicate}) LIMIT 1`,
      );
      if (missing.rows.length)
        throw new SnapshotVerificationError("reference", table.name);
    }
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
        const table = businessSchema.tables.find((t) => t.name === row.table)!;
        const columns = table.columns.map((c) => quoted(c.name));
        try {
          await tx.query(
            `INSERT INTO ${quoted(table.name)}(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`,
            rowParameters(row),
          );
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

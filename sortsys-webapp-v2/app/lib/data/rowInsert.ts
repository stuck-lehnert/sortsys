import type { BusinessTransaction } from "./database";
import { primaryColumns, quoted, type BusinessTable } from "./schema";

const MAX_PARAMETER_BYTES = 2 * 1024 * 1024;

function bindingSize(value: unknown): number {
  if (typeof value === "string") return value.length * 6 + 2;
  if (!Array.isArray(value)) return 32;
  return value.reduce((size, item) => size + bindingSize(item) + 1, 2);
}

/** Bind values in bounded groups. A larger individual row gets its own query. */
export async function insertTableRows(
  tx: BusinessTransaction,
  table: BusinessTable,
  rows: Iterable<Readonly<Record<string, unknown>>>,
  mode: "insert" | "upsert" = "insert",
): Promise<void> {
  const columns = table.columns.map((column) => column.name);
  const columnList = columns.map(quoted).join(",");
  const maxRows = Math.min(128, Math.max(1, Math.floor(4096 / columns.length)));
  let conflict = "";
  if (mode === "upsert") {
    const key = primaryColumns(table);
    const updates = columns.filter((column) => !key.includes(column));
    const target = ` ON CONFLICT (${key.map(quoted).join(",")})`;
    const assignments = updates.map((column) => {
      const name = quoted(column);
      return `${name}=excluded.${name}`;
    });
    conflict = assignments.length
      ? `${target} DO UPDATE SET ${assignments.join(",")}`
      : `${target} DO NOTHING`;
  }

  let bindings: unknown[] = [];
  let size = 0;
  async function flush() {
    const placeholders = Array.from(
      { length: bindings.length / columns.length },
      (_, row) => {
        const start = row * columns.length + 1;
        const parameters = columns.map((_, column) => `$${start + column}`);
        return `(${parameters.join(",")})`;
      },
    );
    await tx.query(
      `INSERT INTO ${quoted(table.name)}(${columnList}) VALUES ${placeholders.join(",")}${conflict}`,
      bindings,
    );
    size = 0;
    bindings = [];
  }

  for (const row of rows) {
    const cells = columns.map((column) =>
      Object.hasOwn(row, column) ? row[column] : null,
    );
    const bytes = cells.reduce<number>((total, cell) => total + bindingSize(cell), 0);
    const full = bindings.length / columns.length >= maxRows;
    if (bindings.length && (full || size + bytes > MAX_PARAMETER_BYTES)) {
      await flush();
    }
    bindings.push(...cells);
    size += bytes;
  }
  if (bindings.length) await flush();
}

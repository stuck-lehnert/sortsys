import generated from "~/generated/browser-schema.generated.json";
import type { BusinessTransaction } from "./database";

export type BusinessColumn = {
  name: string;
  type: string;
  sqlType: string;
  nullable: boolean;
  maxLength: number | null;
  precision: number | null;
  scale: number | null;
  default: string | null;
};
export type BusinessConstraint = {
  kind: string;
  expression: string;
  columns: string[];
  referencedTable: string | null;
  referencedColumns: string[];
};
export type BusinessUniqueIndex = {
  name: string;
  expressions: string[];
  predicate: string | null;
  nullsNotDistinct: boolean;
};
export type BusinessTable = {
  name: string;
  columns: BusinessColumn[];
  constraints: BusinessConstraint[];
  uniqueIndexes: BusinessUniqueIndex[];
};
export type BusinessSchema = {
  format: string;
  fingerprint: string;
  tables: BusinessTable[];
  enums: Record<string, string[]>;
};
export const businessSchema: BusinessSchema = generated;
const tables = new Map(
  businessSchema.tables.map((table) => [table.name, table]),
);

export function tableDefinition(name: string): BusinessTable {
  const table = tables.get(name);
  if (!table) throw new Error("Unsupported business table");
  return table;
}

export function quoted(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error("Invalid schema identifier");
  return `"${name}"`;
}

const duckTypes = new Map([
  ["int8", "BIGINT"],
  ["int4", "INTEGER"],
  ["int2", "SMALLINT"],
  ["float8", "DOUBLE"],
  ["bool", "BOOLEAN"],
  ["text", "VARCHAR"],
  ["varchar", "VARCHAR"],
  ["jsonb", "VARCHAR"],
  ["date", "DATE"],
  ["timestamptz", "TIMESTAMPTZ"],
]);

export function duckType(column: BusinessColumn): string {
  const array = column.type.startsWith("_");
  const type = array ? column.type.slice(1) : column.type;
  let mapped = duckTypes.get(type);
  if (
    type === "numeric" &&
    column.precision &&
    column.precision <= 38 &&
    column.scale !== null
  )
    mapped = `DECIMAL(${column.precision},${column.scale})`;
  if (businessSchema.enums[type]) mapped = "VARCHAR";
  if (!mapped) throw new Error(`Unsupported business type: ${type}`);
  return `${mapped}${array ? "[]" : ""}`;
}

/** Install the browser's explicit logical model. Cross-row validation runs in
 * the same local transaction before a decrypted change is published. */
export async function installBusinessSchema(
  tx: BusinessTransaction,
  partial = false,
): Promise<void> {
  const statements = [
    "CREATE MACRO btrim(value) AS trim(value); CREATE MACRO num_nonnulls(a,b,c,d) AS (CAST(a IS NOT NULL AS INTEGER)+CAST(b IS NOT NULL AS INTEGER)+CAST(c IS NOT NULL AS INTEGER)+CAST(d IS NOT NULL AS INTEGER))",
  ];
  for (const table of businessSchema.tables) {
    const fields = table.columns.map((column) => {
      const name = quoted(column.name);
      let field = `${name} ${duckType(column)}`;
      if (!partial && !column.nullable) field += " NOT NULL";
      if (column.maxLength !== null)
        field += ` CHECK(length(${name})<=${column.maxLength})`;
      return field;
    });
    for (const constraint of table.constraints.filter(
      (c) => c.kind === "p" || c.kind === "u",
    )) {
      fields.push(
        `${constraint.kind === "p" ? "PRIMARY KEY" : "UNIQUE"}(${constraint.columns.map(quoted).join(",")})`,
      );
    }
    statements.push(`CREATE TABLE ${quoted(table.name)}(${fields.join(",")})`);
  }
  await tx.exec(statements.join(";\n"));
}

export function primaryColumns(table: BusinessTable): string[] {
  const key = table.constraints.find((c) => c.kind === "p");
  if (!key?.columns.length)
    throw new Error("Business table has no primary key");
  return key.columns;
}

/** DuckDB does not permit subqueries in CHECK constraints. PostgreSQL's ANY
 * checks bind as subqueries there, but are valid SELECT expressions. Evaluate
 * them inside the same transaction before publishing a decrypted row. */
export function checkExpression(table: BusinessTable): string {
  return (
    table.constraints
      .filter((c) => c.kind === "c")
      .map((c) => {
        if (!c.expression.startsWith("CHECK ("))
          throw new Error("Invalid schema constraint");
        return `((${c.expression.slice(6)}) IS NOT FALSE)`;
      })
      .join(" AND ") || "TRUE"
  );
}

/** The caller selects applicable rows from the referencing table as `source`. */
export function missingReference(key: BusinessConstraint): string {
  if (key.kind !== "f" || !key.referencedTable) {
    throw new Error("Invalid foreign key");
  }
  const target = tableDefinition(key.referencedTable);
  const match = key.columns.map((column, index) => {
    const referenced = key.referencedColumns[index]!;
    return `target.${quoted(referenced)}=source.${quoted(column)}`;
  });
  return `NOT EXISTS(SELECT 1 FROM ${quoted(target.name)} target WHERE ${match.join(" AND ")})`;
}

/** DuckDB has no partial unique indexes. Check the model's uniqueness rules
 * inside the same local transaction before publishing any change. */
export async function assertUniqueIndexes(
  tx: BusinessTransaction,
  table: BusinessTable,
): Promise<void> {
  for (const index of table.uniqueIndexes) {
    const expressions = index.expressions.map(
      (expression) => `(${expression})`,
    );
    if (!expressions.length) throw new Error("Invalid unique index");
    const predicate = [`(${index.predicate ?? "TRUE"})`];
    if (!index.nullsNotDistinct)
      predicate.push(
        ...expressions.map((expression) => `${expression} IS NOT NULL`),
      );
    const duplicate = await tx.query(
      `SELECT 1 FROM ${quoted(table.name)} WHERE ${predicate.join(" AND ")} GROUP BY ${expressions.join(",")} HAVING count(*)>1 LIMIT 1`,
    );
    if (duplicate.rows.length) throw new Error("Duplicate business key");
  }
}

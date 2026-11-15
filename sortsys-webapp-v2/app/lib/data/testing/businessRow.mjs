import { businessSchema, tableDefinition } from "../schema";

function defaultColumnValue(column) {
  if (column.nullable) return null;
  if (column.type.startsWith("_")) return [];
  if (column.type.startsWith("int")) return "1";
  switch (column.type) {
    case "numeric":
      return "0";
    case "float8":
      return 0;
    case "bool":
      return false;
    case "date":
      return "2026-11-08";
    case "timestamptz":
      return "2026-11-08T12:30:00.123456Z";
    case "jsonb":
      return "{}";
    default:
      return "Text".slice(0, column.maxLength ?? 4);
  }
}

/** Schema-shaped synthetic rows for unit and browser fixtures. Domain-specific
 * required values and relationships remain explicit at each call site. */
export function row(table, overrides = {}) {
  const values = {};
  for (const column of tableDefinition(table).columns) {
    if (Object.hasOwn(overrides, column.name))
      values[column.name] = overrides[column.name];
    else values[column.name] = defaultColumnValue(column);
  }
  return {
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table,
    values,
  };
}

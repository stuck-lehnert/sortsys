import { timestampInstant } from "./timestamps";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { businessSchema, tableDefinition } from "./schema";
import type { BusinessColumn } from "./schema";

export type BusinessRow = {
  format: "sortsys-row-v2";
  schema: string;
  table: string;
  values: Record<string, unknown>;
};
export type BusinessFields = { table: string; values: Record<string, unknown> };
const INTEGER_BOUNDS: Record<string, [bigint, bigint]> = {
  int8: [-9223372036854775808n, 9223372036854775807n],
  int4: [-2147483648n, 2147483647n],
  int2: [-32768n, 32767n],
};

function json(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new InvalidProtectedData();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && !value.includes("\0")) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100_000)
    return value.map((v) => json(v, depth + 1));
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const keys = Object.keys(value);
    if (
      keys.length > 10_000 ||
      keys.some(
        (k) =>
          k.includes("\0") ||
          ["__proto__", "constructor", "prototype"].includes(k),
      )
    )
      throw new InvalidProtectedData();
    return Object.fromEntries(
      keys.map((k) => [
        k,
        json((value as Record<string, unknown>)[k], depth + 1),
      ]),
    );
  }
  throw new InvalidProtectedData();
}

function cell(value: unknown, column: BusinessColumn): unknown {
  if (value === null) {
    if (column.nullable) return null;
    throw new InvalidProtectedData();
  }
  const type = column.type;
  if (type.startsWith("_")) {
    if (!Array.isArray(value) || value.length > 100_000)
      throw new InvalidProtectedData();
    return value.map((item) =>
      cell(item, { ...column, type: type.slice(1), nullable: false }),
    );
  }
  const bounds = INTEGER_BOUNDS[type];
  if (bounds) {
    if (
      typeof value !== "string" ||
      !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value) ||
      value.length > 20
    )
      throw new InvalidProtectedData();
    const integer = BigInt(value);
    if (integer < bounds[0] || integer > bounds[1])
      throw new InvalidProtectedData();
    return value;
  }
  if (type === "numeric") {
    if (
      typeof value !== "string" ||
      value.length > 128 ||
      !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
    )
      throw new InvalidProtectedData();
    const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
    if (column.scale !== null && fraction.length > column.scale)
      throw new InvalidProtectedData();
    if (
      column.precision !== null &&
      column.scale !== null &&
      whole!.replace(/^0+/, "").length > column.precision - column.scale
    )
      throw new InvalidProtectedData();
    return value;
  }
  if (type === "float8") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new InvalidProtectedData();
    return value;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new InvalidProtectedData();
    return value;
  }
  if (type === "jsonb") {
    if (typeof value !== "string" || value.length > 128 * 1024 * 1024)
      throw new InvalidProtectedData();
    // Parse only for validation. Store the original JSON text, preserving exact
    // numeric lexemes and distinguishing JSON null from SQL NULL.
    json(JSON.parse(value));
    return value;
  }
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > 20 * 1024 * 1024
  )
    throw new InvalidProtectedData();
  if (column.maxLength !== null && [...value].length > column.maxLength)
    throw new InvalidProtectedData();
  if (type === "date") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw new InvalidProtectedData();
  } else if (type === "timestamptz") {
    timestampInstant(value);
  } else if (
    type !== "text" &&
    type !== "varchar" &&
    !businessSchema.enums[type]?.includes(value)
  )
    throw new InvalidProtectedData();
  return value;
}

/** Full row snapshots use canonical decimal strings for every integer. This
 * rejects extra columns before the database could silently discard them. */
export function decodeBusinessRow(input: unknown): BusinessRow {
  try {
    const envelope = record(input, ["format", "schema", "table", "values"]);
    if (
      envelope.format !== "sortsys-row-v2" ||
      envelope.schema !== businessSchema.fingerprint ||
      typeof envelope.table !== "string"
    )
      throw new InvalidProtectedData();
    const table = tableDefinition(envelope.table);
    const values = record(
      envelope.values,
      table.columns.map((c) => c.name),
    );
    return {
      format: "sortsys-row-v2",
      schema: businessSchema.fingerprint,
      table: table.name,
      values: Object.fromEntries(
        table.columns.map((column) => [
          column.name,
          cell(values[column.name], column),
        ]),
      ),
    };
  } catch {
    throw new InvalidProtectedData();
  }
}

/** Missing fields are unavailable, not SQL NULL. Only supplied cells are
 * validated; every primary-key component must still be known. */
export function decodeBusinessFields(
  table: string,
  input: unknown,
): BusinessFields {
  try {
    const definition = tableDefinition(table),
      columns = new Map(
        definition.columns.map((column) => [column.name, column]),
      );
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype
    )
      throw new InvalidProtectedData();
    const source = input as Record<string, unknown>,
      values: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(source)) {
      const column = columns.get(name);
      if (!column) throw new InvalidProtectedData();
      values[name] = cell(value, column);
    }
    const key = definition.constraints.find(
      (constraint) => constraint.kind === "p",
    );
    if (
      !key ||
      key.columns.some(
        (name) => !Object.hasOwn(values, name) || values[name] === null,
      )
    )
      throw new InvalidProtectedData();
    return { table, values };
  } catch {
    throw new InvalidProtectedData();
  }
}

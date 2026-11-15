import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";

export type MasterCollection = "jobs" | "scans" | "usage" | "uploads";
export type MasterRecord = {
  format: "sortsys-master-record-v1";
  collection: MasterCollection;
  columns: { name: string; type: string }[];
  values: Record<string, string | null>;
};

/** Every SQL value remains text, including nested JSON and 64-bit IDs. SQL NULL
 * is separate from the string "null" belonging to an actual JSON null value. */
export function masterRecord(
  input: unknown,
  expected: { collection: MasterCollection; row: string; tenant: string },
): MasterRecord {
  const value = record(input, ["format", "collection", "columns", "values"]);
  if (
    value.format !== "sortsys-master-record-v1" ||
    value.collection !== expected.collection ||
    !Array.isArray(value.columns) ||
    !value.columns.length ||
    value.columns.length > 1600
  ) {
    throw new InvalidProtectedData();
  }
  const names = new Set<string>();
  const columns = value.columns.map((input) => {
    const column = record(input, ["name", "type"]);
    if (
      typeof column.name !== "string" ||
      !column.name ||
      column.name.includes("\0") ||
      new TextEncoder().encode(column.name).length > 63 ||
      names.has(column.name) ||
      typeof column.type !== "string" ||
      !column.type ||
      column.type.length > 1024
    ) {
      throw new InvalidProtectedData();
    }
    names.add(column.name);
    return { name: column.name, type: column.type };
  });
  const values = record(value.values, [...names]);
  if (
    values.id !== expected.row ||
    values.tenant_name !== expected.tenant ||
    Object.values(values).some(
      (value) => value !== null && typeof value !== "string",
    )
  ) {
    throw new InvalidProtectedData();
  }
  return {
    format: value.format,
    collection: expected.collection,
    columns,
    values: { ...values } as MasterRecord["values"],
  };
}

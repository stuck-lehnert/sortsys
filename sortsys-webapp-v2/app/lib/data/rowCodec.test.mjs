import { expect, test } from "bun:test";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema, tableDefinition } from "./schema";

function row(table, overrides = {}) {
  return { format: "sortsys-row-v2", schema: businessSchema.fingerprint, table,
    values: Object.fromEntries(tableDefinition(table).columns.map(c => [c.name, Object.hasOwn(overrides, c.name) ? overrides[c.name] : c.nullable ? null
      : c.type.startsWith("_") ? [] : c.type.startsWith("int") ? "1" : c.type === "numeric" ? "0" : c.type === "float8" ? 0
      : c.type === "bool" ? false : c.type === "date" ? "2026-11-08" : c.type === "timestamptz" ? "2026-11-08T12:30:00.123456Z" : c.type === "jsonb" ? "{}" : "Text".slice(0,c.maxLength ?? 4)])) };
}
export { row };

test("private rows reject unknown fields, credential columns and imprecise integers", () => {
  const user = row("users");
  expect(() => decodeBusinessRow({ ...user, extra: "arbitrary" })).toThrow();
  expect(() => decodeBusinessRow({ ...user, values: { ...user.values, password: "never allowed" } })).toThrow();
  expect(() => decodeBusinessRow(row("users", { id: 9223372036854775807 }))).toThrow();
  expect(() => decodeBusinessRow(row("users", { id: "9223372036854775808" }))).toThrow();
  expect(decodeBusinessRow(row("users", { id: "9223372036854775807" })).values.id).toBe("9223372036854775807");
  expect(() => decodeBusinessRow({ ...user, schema: "unknown-future-schema" })).toThrow();
});

test("monetary values retain their exact decimal representation and reject implicit rounding", () => {
  expect(decodeBusinessRow(row("commercial_cases", { net_amount: "1234567890123.45" })).values.net_amount).toBe("1234567890123.45");
  for (const invalid of [123.45, "123,45", "123.456", "12345678901234.56", "NaN", "Infinity", "1e10"]) {
    expect(() => decodeBusinessRow(row("commercial_cases", { net_amount: invalid }))).toThrow();
  }
});

test("rows reject invalid dates, non-finite numbers and prototype-bearing JSON", () => {
  expect(() => decodeBusinessRow(row("commercial_cases", { valid_until: "2026-02-30" }))).toThrow();
  expect(() => decodeBusinessRow(row("commercial_cases", { modified_at: "2026-02-30T12:00:00Z" }))).toThrow();
  expect(() => decodeBusinessRow(row("users", { cost_per_hour: Infinity }))).toThrow();
  expect(() => decodeBusinessRow(row("commercial_cases", { scope_item_ids: JSON.parse('{"__proto__":{"polluted":true}}') }))).toThrow();
  expect(() => decodeBusinessRow(row("commercial_cases", { scope_item_ids: '{"__proto__":{"polluted":true}}' }))).toThrow();
  expect(() => decodeBusinessRow(row("commercial_cases", { scope_item_ids: '{"broken":' }))).toThrow();
});

test("JSON cells retain exact nested numbers and distinguish JSON null from SQL null", () => {
  const source='{"id":9223372036854775807,"amount":1234567890123.45,"items":[true,null,"ä"]}';
  expect(decodeBusinessRow(row("global_settings", { name: source })).values.name).toBe(source);
  expect(decodeBusinessRow(row("global_settings", { name: "null" })).values.name).toBe("null");
  expect(decodeBusinessRow(row("global_settings", { name: null })).values.name).toBeNull();
});

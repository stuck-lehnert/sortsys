import { expect, test } from "bun:test";
import { masterRecord } from "./masterRecord";

const expected = {
  collection: "jobs",
  row: "9223372036854775807",
  tenant: "test",
};
const source = {
  format: "sortsys-master-record-v1",
  collection: "jobs",
  columns: [
    { name: "id", type: "bigint" },
    { name: "tenant_name", type: "character varying(127)" },
    { name: "payload", type: "jsonb" },
    { name: "result", type: "jsonb" },
  ],
  values: {
    id: expected.row,
    tenant_name: "test",
    payload: '{"price":12345.678900,"id":9223372036854775807}',
    result: "null",
  },
};

test("master archives retain exact decimal/64-bit text and distinguish SQL NULL from JSON null", () => {
  expect(masterRecord(source, expected)).toEqual(source);
  expect(
    masterRecord(
      { ...source, values: { ...source.values, result: null } },
      expected,
    ).values.result,
  ).toBeNull();
  expect(masterRecord(source, expected).values.payload).toContain(
    "12345.678900",
  );
});

test("master rows bind tenant, collection, row ID and complete column coverage", () => {
  for (const changed of [
    { ...source, collection: "scans" },
    { ...source, values: { ...source.values, tenant_name: "other" } },
    { ...source, values: { ...source.values, id: "1" } },
    { ...source, values: { ...source.values, extra: "unexpected" } },
    { ...source, values: { ...source.values, id: 9223372036854775807 } },
    { ...source, columns: [...source.columns, source.columns[0]] },
    { ...source, columns: source.columns.slice(1) },
    {
      ...source,
      columns: [
        { ...source.columns[0], extra: "unexpected" },
        ...source.columns.slice(1),
      ],
    },
  ]) {
    expect(() => masterRecord(changed, expected)).toThrow();
  }
});

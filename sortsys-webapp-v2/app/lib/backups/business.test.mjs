import { expect, test } from "bun:test";
import { tableDefinition } from "../data/schema";
import { row } from "../data/testing/businessRow.mjs";
import { duckDriver } from "../data/testing/duckDriver.mjs";
import { backupBusinessRow, openPostgresBackup } from "./business";
import { InvalidPostgresBackup } from "./postgres";

test("invalid source schemas retain a useful backup error through the local transaction", async () => {
  await expect(
    openPostgresBackup(
      new Blob([
        "COPY public.unknown_business_table (id) FROM stdin;\n1\n\\.\n",
      ]),
      new AbortController().signal,
      await duckDriver(),
    ),
  ).rejects.toThrow(InvalidPostgresBackup);
});

function source(table, overrides = {}) {
  const fixture = row(table, overrides);
  const columns = tableDefinition(table).columns;
  const values = columns.map((column) => {
    const value = fixture.values[column.name];
    if (value === null) return null;
    if (column.type === "bool") return value ? "t" : "f";
    if (column.type === "timestamptz")
      return value.replace("T", " ").replace("Z", "+00");
    if (column.type.startsWith("_")) return "{}";
    return String(value);
  });
  return {
    schema: "public",
    table,
    columns: columns.map((column) => column.name),
    values,
  };
}

function copy(table) {
  const values = table.values.map((value) => {
    if (value === null) return "\\N";
    return value
      .replaceAll("\\", "\\\\")
      .replaceAll("\t", "\\t")
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r");
  });
  return `COPY public.${table.table} (${table.columns.join(", ")}) FROM stdin;\n${values.join("\t")}\n\\.\n`;
}

test("old rows become typed business values without copying credentials or losing decimal precision", () => {
  const user = source("users", {
    id: "9223372036854775807",
    contract_type: "internal",
    cost_per_hour: 0.12345678901234566,
  });
  user.columns.push("password", "totp_uri");
  user.values.push("not-a-new-login-credential", "not-a-new-two-factor-secret");
  const decoded = backupBusinessRow(user);
  expect(decoded.values.id).toBe("9223372036854775807");
  expect(decoded.values.cost_per_hour).toBe(0.12345678901234566);
  expect(decoded.values.created_at).toBe("2026-11-08T12:30:00.123456+00:00");
  expect(decoded.values).not.toHaveProperty("password");
  expect(decoded.values).not.toHaveProperty("totp_uri");
  const offer = backupBusinessRow(
    source("commercial_cases", {
      existing_contract: true,
      net_amount: "1234567890123.45",
      scope_item_ids: "[9223372036854775807]",
    }),
  );
  expect(offer.values.existing_contract).toBe(true);
  expect(offer.values.net_amount).toBe("1234567890123.45");
  expect(offer.values.scope_item_ids).toBe("[9223372036854775807]");
});

test("PostgreSQL array quoting is decoded after COPY escaping", () => {
  const change = source("entity_changes");
  change.values[change.columns.indexOf("changed_columns")] =
    String.raw`{"name","a,b","a\"b","a\\b","NULL"}`;
  change.values[change.columns.indexOf("participant_user_ids")] =
    "{9223372036854775807,1}";
  const decoded = backupBusinessRow(change);
  expect(decoded.values.changed_columns).toEqual([
    "name",
    "a,b",
    'a"b',
    "a\\b",
    "NULL",
  ]);
  expect(decoded.values.participant_user_ids).toEqual([
    "9223372036854775807",
    "1",
  ]);
  change.values[change.columns.indexOf("changed_columns")] =
    String.raw`{\NULL,hello\ }`;
  expect(backupBusinessRow(change).values.changed_columns).toEqual([
    "NULL",
    "hello ",
  ]);
  for (const invalid of ["{1,}", "{{1}}", "{NULL}", "[2:3]={1,2}"]) {
    change.values[change.columns.indexOf("participant_user_ids")] = invalid;
    expect(() => backupBusinessRow(change)).toThrow();
  }
});

test("unknown columns and unsupported schema changes cannot silently discard business data", () => {
  const product = source("products");
  expect(() => backupBusinessRow({ ...product, schema: "another" })).toThrow();
  expect(() =>
    backupBusinessRow({
      ...product,
      columns: [...product.columns, "extra"],
      values: [...product.values, "preserve me"],
    }),
  ).toThrow();
  expect(() =>
    backupBusinessRow({
      ...product,
      columns: product.columns.slice(1),
      values: product.values.slice(1),
    }),
  ).toThrow();
  const contract = source("commercial_cases");
  contract.values[contract.columns.indexOf("existing_contract")] = "anything";
  expect(() => backupBusinessRow(contract)).toThrow();
});

test("a Gzip backup opens in private DuckDB and validates references without any PostgreSQL service", async () => {
  const product = source("products", {
    id: "9223372036854775807",
    custom_id: "1",
    name: "Fassadenfarbe",
    description: "matte Oberfläche",
    base_unit: "l",
    other_units: "[]",
  });
  const dump =
    copy(product) +
    "COPY public.commercial_offer_counters (scope,next_number) FROM stdin;\nglobal\t9223372036854775808\n\\.\n" +
    "COPY public.commercial_offer_number_reservations (number) FROM stdin;\n26-11-11-5\n999\n\\.\n" +
    "COPY public.user_sessions (id,token) FROM stdin;\n1\tnever-import-this\n\\.\n";
  const file = await new Response(
    new Blob([dump]).stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  const opened = await openPostgresBackup(
    file,
    new AbortController().signal,
    await duckDriver(),
  );
  try {
    expect(opened.rows).toBe(1n);
    expect(opened.offerNumbers).toEqual({
      nextNumber: "9223372036854775808",
      reservations: new Set(["26-11-11-5", "999"]),
    });
    const rows = (
      await opened.database.query("SELECT id,name,description FROM products")
    ).rows;
    expect(rows).toEqual([
      {
        id: 9223372036854775807n,
        name: "Fassadenfarbe",
        description: "matte Oberfläche",
      },
    ]);
    await expect(
      opened.database.query("SELECT * FROM user_sessions"),
    ).rejects.toThrow();
    await expect(
      opened.database.query("SELECT * FROM read_csv('/tmp/forbidden')"),
    ).rejects.toThrow();
  } finally {
    await opened.database.close();
  }

  const missingProject = source("commercial_cases", {
    reference: "offer-1",
    kind: "offer",
    status: "draft",
    project_id: "999",
    scope_item_ids: "[]",
  });
  await expect(
    openPostgresBackup(
      new Blob([copy(missingProject)]),
      new AbortController().signal,
      await duckDriver(),
    ),
  ).rejects.toThrow();
}, 120000);

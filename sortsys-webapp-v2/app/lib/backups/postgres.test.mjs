import { expect, test } from "bun:test";
import {
  copyText,
  InvalidPostgresBackup,
  readPostgresBackup,
} from "./postgres";

async function rows(file, options) {
  const result = [];
  for await (const row of readPostgresBackup(file, options)) result.push(row);
  return result;
}
const dump = [
  "-- PostgreSQL database dump",
  String.raw`\restrict synthetic_token`,
  "SET client_encoding = 'UTF8';",
  "CREATE TABLE public.products (id bigint, name text, description text, price numeric);",
  "COPY public.products (id, name, description, price) FROM stdin;",
  [
    "9223372036854775807",
    "Silikatfarbe ÄÖÜß",
    String.raw`Absatz 1\nAbsatz 2\tmit Tab`,
    "17.375",
  ].join("\t"),
  ["2", String.raw`\\N`, String.raw`\N`, "0.00"].join("\t"),
  String.raw`\.`,
  'COPY public."Projekt Daten" ("Feld, eins", "zwei""drei") FROM stdin;',
  ["Fenster", String.raw`Schritt\\Pfad`].join("\t"),
  String.raw`\.`,
  String.raw`\unrestrict synthetic_token`,
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

test("SQL/Gzip backups preserve full integers, decimals, nulls, text and quoted identifiers", async () => {
  const plain = new Blob([dump]);
  const compressed = await new Response(
    plain.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
  const expected = await rows(plain);
  expect(expected).toEqual(await rows(compressed));
  expect(expected[0]).toEqual({
    schema: "public",
    table: "products",
    columns: ["id", "name", "description", "price"],
    values: [
      "9223372036854775807",
      "Silikatfarbe ÄÖÜß",
      "Absatz 1\nAbsatz 2\tmit Tab",
      "17.375",
    ],
  });
  expect(expected[1].values).toEqual(["2", "\\N", null, "0.00"]);
  expect(expected[2]).toEqual({
    schema: "public",
    table: "Projekt Daten",
    columns: ["Feld, eins", 'zwei"drei'],
    values: ["Fenster", "Schritt\\Pfad"],
  });
});

test("COPY-looking text in SQL functions and nested comments is never imported or executed", async () => {
  const source = String.raw`CREATE FUNCTION public.noop() RETURNS text AS $function$
COPY public.products (id) FROM stdin;
999
\.
$function$ LANGUAGE sql;
/* outer /* inner */
COPY public.products (id) FROM stdin;
not data
*/
COPY public.products (id) FROM stdin;
17
\.
DROP TABLE public.products;
`;
  expect(await rows(new Blob([source]))).toEqual([
    { schema: "public", table: "products", columns: ["id"], values: ["17"] },
  ]);
});

test("multiline COPY headers, CRLF and table selection are supported", async () => {
  const source =
    "COPY public.products (\n id, name\n) FROM stdin;\n1\tFarbe\n\\.\nCOPY private.accounts (secret) FROM stdin;\nunused\n\\.\n".replaceAll(
      "\n",
      "\r\n",
    );
  expect(
    await rows(new Blob([source]), {
      acceptTable: (schema) => schema === "public",
    }),
  ).toHaveLength(1);
});

test("COPY byte escapes retain UTF-8 and reject invalid bytes", () => {
  expect(copyText(String.raw`\303\244\xC3\xB6`)).toBe("äö");
  expect(copyText(String.raw`\N`)).toBeNull();
  expect(copyText(String.raw`\\N`)).toBe("\\N");
  expect(copyText("\\" + "😀")).toBe("😀");
  expect(() => copyText(String.raw`\377`)).toThrow(InvalidPostgresBackup);
  expect(() => copyText(String.raw`\000`)).toThrow(InvalidPostgresBackup);
});

test("truncated, incompatible and oversized inputs cannot silently finish", async () => {
  for (const source of [
    "COPY public.products (id,name) FROM stdin;\n1\n\\.\n",
    "COPY public.products (id) FROM stdin;\n1\n",
    "COPY public.products (id) FROM PROGRAM 'anything';\n",
    "CREATE FUNCTION x() RETURNS text AS $$incomplete",
    "PGDMP binary archive",
  ])
    await expect(rows(new Blob([source]))).rejects.toThrow();
  await expect(
    rows(
      new Blob([
        "COPY public.products (name) FROM stdin;\n" +
          "x".repeat(200) +
          "\n\\.\n",
      ]),
      { maxRowBytes: 100 },
    ),
  ).rejects.toThrow(InvalidPostgresBackup);
  const controller = new AbortController();
  controller.abort();
  await expect(
    rows(new Blob([dump]), { signal: controller.signal }),
  ).rejects.toThrow();
});

test("large escaped fields do not depend on the JavaScript function argument limit", () => {
  const value = "a".repeat(200_000) + String.raw`\n`;
  expect(copyText(value)).toBe("a".repeat(200_000) + "\n");
});

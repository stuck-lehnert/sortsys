import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readGaebInput } from "./legacy";
import { validateGaebXml } from "./validation";
const schemas: Record<string, string> = {};
const directory = new URL("../../vendor/gaeb/3.3/", import.meta.url);
for (const file of readdirSync(directory).filter((file) =>
  file.endsWith(".xsd"),
))
  schemas[`3.3/${file}`] = readFileSync(new URL(file, directory), "utf8");
const record = (
  kind: string,
  fields: Array<[number, string]>,
  index: number,
) => {
  const chars = Array(80).fill(" ");
  for (const [start, value] of [
    [0, kind],
    [74, String(index).padStart(6, "0")],
    ...fields,
  ] as Array<[number, string]>)
    Array.from(value).forEach((char, i) => (chars[start + i] = char));
  return chars.join("");
};
const input = (phase = "83") =>
  [
    record(
      "00",
      [
        [10, phase],
        [12, "L"],
        [62, "1122PPPPI"],
        [71, "90"],
      ],
      1,
    ),
    record("01", [[2, "Innenputz-LV"]], 2),
    record("02", [[2, "Sanierung Musterhalle"]], 3),
    record("08", [[2, "EURO"]], 4),
    record("11", [[2, "01"]], 5),
    record("12", [[2, "Innenausbau"]], 6),
    record("11", [[2, "0101"]], 7),
    record("12", [[2, "Putzarbeiten"]], 8),
    record(
      "21",
      [
        [2, "01010010A"],
        [11, "NNN"],
        [23, "00000012500"],
        [34, "m²"],
      ],
      9,
    ),
    record("25", [[2, "Wände verputzen"]], 10),
    record("26", [[5, "Untergrund schützen und grundieren."]], 11),
    record("99", [], 12),
  ].join("\r\n");
const valid = (xml: string) => {
  const result = validateGaebXml(
    xml,
    { phase: "83", version: "3.3", date: "2021-05" },
    schemas,
  );
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
};
test("D83 fixed-width quantities, OZ hierarchy, index and Windows-1252 characters become schema-valid native X83 while preserving the original bytes", () => {
  const source = input(),
    bytes = Uint8Array.from(source, (char) => char.charCodeAt(0));
  const result = readGaebInput(bytes, "Innenputz.D83");
  assert.equal(result.fileName, "Innenputz.x83");
  assert.ok(result.xml.includes("<Qty>12.500</Qty>"));
  assert.ok(result.xml.includes("<QU>m²</QU>"));
  assert.ok(result.xml.includes('RNoPart="0010" RNoIndex="A"'));
  assert.ok(result.xml.includes("Wände verputzen"));
  assert.ok(result.xml.includes("Sanierung Musterhalle"));
  assert.ok(result.xml.includes(btoa(String.fromCharCode(...bytes))));
  valid(result.xml);
});
const p83 = readFileSync(
  new URL("../../scripts/fixtures/legacy/anfrage.p83", import.meta.url),
  "utf8",
);
test("P83 object hierarchy, decimal comma, RTF paragraphs, hex escapes and Unicode decode without exposing RTF tables", () => {
  const result = readGaebInput(new TextEncoder().encode(p83), "Anfrage.p83");
  valid(result.xml);
  assert.equal(result.format, "gaeb2000");
  assert.ok(result.xml.includes("Wände verputzen"));
  assert.ok(result.xml.includes("Zweite Zeile mit ü und Fett."));
  assert.ok(result.xml.includes("<Qty>12.500</Qty>"));
  assert.ok(!result.xml.includes("Arial"));
});
test("native XML is kept verbatim and the content decides the format despite a renamed extension", () => {
  const xml = '<?xml version="1.0"?><GAEB keep="✓"/>';
  assert.equal(readGaebInput(new TextEncoder().encode(xml), "a.d83").xml, xml);
  assert.equal(
    readGaebInput(new TextEncoder().encode(p83), "a.d83").format,
    "gaeb2000",
  );
});
test("wrong phases, truncated or malformed records, invalid quantities, unsupported position types and deeply nested objects fail clearly", () => {
  for (const source of [
    input("84"),
    input().replace("00000012500", "bad00012500"),
    input().slice(1),
    input().replace("NNN", "ANN"),
    p83.replace("#end[Position]", "#end[Other]"),
    "#begin[GAEB]" + "#begin[X]".repeat(100),
  ])
    assert.throws(() =>
      readGaebInput(new TextEncoder().encode(source), "a.d83"),
    );
});

test("DOS CP850 umlauts are recognized without corrupting quantities or the retained bytes", () => {
  const source = input();
  const mapping: Record<string, number> = { ä: 0x84, ü: 0x81, "²": 0xfd };
  const bytes = Uint8Array.from(
    source,
    (char) => mapping[char] ?? char.charCodeAt(0),
  );
  const result = readGaebInput(bytes, "dos.d83");
  valid(result.xml);
  assert.ok(result.xml.includes("Wände verputzen"));
  assert.ok(result.xml.includes("schützen"));
  assert.ok(result.xml.includes("<Qty>12.500</Qty>"));
});

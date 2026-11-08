import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { readGaebInput } from "./legacy";
import { validateGaebXml } from "./validation";
import type { GaebPhase } from "./types";
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
const valid = (xml: string, phase: GaebPhase = "83") => {
  const result = validateGaebXml(
    xml,
    { phase, version: "3.3", date: "2021-05" },
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
    input("89"),
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

for (const phase of ["84", "85", "86", "87"] as const) {
  test(`D${phase} retains the actual phase, exact prices, quantities and original bytes`, () => {
    const records = input(phase).split("\r\n");
    records.splice(9, 0, record("23", [[2, "01010010A"], [12, "00000012340"], [24, "000000015425"]], 10));
    const source = records.map((line, i) => line.slice(0, 74) + String(i + 1).padStart(6, "0")).join("\r\n");
    const bytes = Uint8Array.from(source, (char) => char.charCodeAt(0));
    const result = readGaebInput(bytes, `Auftrag.D${phase}`);
    valid(result.xml, phase);
    assert.equal(result.fileName, `Auftrag.x${phase}`);
    assert.ok(result.xml.includes("<UP>12.340</UP>"));
    assert.ok(result.xml.includes("<IT>154.25</IT>"));
    assert.ok(result.xml.includes(btoa(String.fromCharCode(...bytes))));
    assert.ok(result.xml.includes("<Total>154.25</Total>"));
    if (phase === "84") {
      assert.ok(result.referenceXml);
      valid(result.referenceXml);
      assert.ok(result.referenceXml.includes("Wände verputzen"));
      assert.ok(result.referenceXml.includes("<QU>m²</QU>"));
    } else assert.ok(result.xml.includes("Wände verputzen"));
  });
  test(`P${phase} converts comma prices and retains its own document phase`, () => {
    const source = p83.replace("[DP]83[end]", `[DP]${phase}[end]`)
      .replace("[ME]m²[end]", "[ME]m²[end][EP]12,340[end][GB]154,25[end]");
    const result = readGaebInput(new TextEncoder().encode(source), `Auftrag.p${phase}`);
    valid(result.xml, phase);
    assert.equal(result.fileName, `Auftrag.x${phase}`);
    assert.ok(result.xml.includes("<Total>154.25</Total>"));
  });
}

test("price-only D84 and P84 retain totals without inventing quantities or units", () => {
  const records = input("84").split("\r\n").filter((line) => !["21", "25", "26"].includes(line.slice(0, 2)));
  records.splice(-1, 0, record("23", [[2, "01010010A"], [12, "00000012340"], [24, "000000015425"]], 10));
  const d84 = records.map((line, i) => line.slice(0, 74) + String(i + 1).padStart(6, "0")).join("\r\n");
  const p84 = p83.replace("[DP]83[end]", "[DP]84[end]")
    .replace("[Menge]12,500[end][ME]m²[end]", "[EP]12,340[end][GB]154,25[end]")
    .replace(/#begin\[Beschreibung\][\s\S]*?#end\[Beschreibung\]/, "");
  for (const [name, source] of [["a.d86", d84], ["a.p84", p84]]) {
    const result = readGaebInput(new TextEncoder().encode(source), name);
    valid(result.xml, "84");
    assert.equal(result.fileName, "a.x84");
    assert.equal(result.referenceXml, undefined);
    assert.ok(!result.xml.includes("<Qty>"));
    assert.ok(!result.xml.includes("<QU>"));
    assert.ok(result.xml.includes("<Total>154.25</Total>"));
  }
});

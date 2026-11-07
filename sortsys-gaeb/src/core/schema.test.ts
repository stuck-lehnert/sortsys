import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGaebXml } from "./validation";
import { createGaebXml } from "./templates";
import { GAEB_PHASES } from "./types";
import { decimal, decimalString, itemAmount } from "./decimal";

const directory = fileURLToPath(new URL("../../vendor/gaeb", import.meta.url));
const schemas: Record<string, string> = {};
for (const version of readdirSync(directory, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory(),
)) {
  for (const name of readdirSync(join(directory, version.name)).filter((name) =>
    name.endsWith(".xsd"),
  ))
    schemas[`${version.name}/${name}`] = readFileSync(
      join(directory, version.name, name),
      "utf8",
    );
}
for (const phase of GAEB_PHASES) {
  test(`new X${phase} is valid against the unmodified official schema`, () => {
    const result = validateGaebXml(
      createGaebXml(phase, "Bauvorhaben – Grüße"),
      { phase, version: "3.3", date: phase === "31" ? "2023-01" : "2021-05" },
      schemas,
    );
    assert.equal(result.valid, true, JSON.stringify(result.issues));
  });
}
test("schema validation rejects wrong phases, structure and decimal precision", () => {
  const source = createGaebXml("83", "LV");
  for (const malformed of [
    source.replace("<DP>83</DP>", "<DP>84</DP>"),
    source.replace("<GAEBInfo>", "<Invalid>"),
    source.replace(
      "<BoQBody/>",
      '<BoQBody><Itemlist><Item ID="a" RNoPart="1"><Qty>1.1234</Qty><QU>m</QU></Item></Itemlist></BoQBody>',
    ),
  ]) {
    assert.equal(
      validateGaebXml(
        malformed,
        { phase: "83", version: "3.3", date: "2021-05" },
        schemas,
      ).valid,
      false,
    );
  }
});
test("DTD/entity payloads are blocked and document schema URLs are not trusted", () => {
  assert.equal(
    validateGaebXml(
      '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>',
      { phase: "83", version: "3.3", date: "2021-05" },
      schemas,
    ).valid,
    false,
  );
  const source = createGaebXml("83", "LV").replace(
    "<GAEB xmlns=",
    '<GAEB xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3 https://example.invalid/evil.xsd" xmlns=',
  );
  assert.equal(
    validateGaebXml(
      source,
      { phase: "83", version: "3.3", date: "2021-05" },
      schemas,
    ).valid,
    true,
  );
});
test("financial arithmetic uses exact decimal multiplication and commercial rounding", () => {
  assert.equal(itemAmount("0.100", "0.100"), "0.01");
  assert.equal(itemAmount("1", "1.005"), "1.01");
  assert.equal(itemAmount("-1", "1.005"), "-1.01");
  assert.equal(itemAmount("3", "0.335", "10"), "0.90");
  assert.equal(decimalString(decimal("12,500", 3, 11), 3), "12.500");
  assert.throws(() => decimal("1.2345", 3, 11));
  assert.throws(() => decimal("1e3", 3, 11));
});

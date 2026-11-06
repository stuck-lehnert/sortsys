import { test } from "node:test";
import assert from "node:assert/strict";
import { gaebUnit } from "./units";

test("written unit names use GAEB abbreviations without truncating unknown units", () => {
  for (const [input, expected] of [
    ["Stück", "Stk"],
    ["STUECK", "Stk"],
    ["pauschal", "psch"],
    ["Quadratmeter", "m²"],
    ["Kubikmeter", "m³"],
    ["Stunden", "h"],
    ["pieces", "pcs"],
    ["meters", "m"],
    [" m² ", "m²"],
    ["lfdm", "lfdm"],
    ["🔧🔧🔧🔧", "🔧🔧🔧🔧"],
  ])
    assert.equal(gaebUnit(input!), expected!);
  for (const input of ["unbekannt", "constructor", "toString", "🔧🔧🔧🔧🔧"])
    assert.throws(() => gaebUnit(input), /unit-too-long/);
});

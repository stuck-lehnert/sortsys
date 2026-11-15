import assert from "node:assert/strict";
import test from "node:test";
import { decimal, itemAmount } from "./decimal";

test("redundant fractional zeros do not change exact decimal precision", () => {
  const examples: [string, number, bigint][] = [
    ["24.000", 2, 2400n],
    ["12.340000", 2, 1234n],
    ["-12.340000", 2, -1234n],
    ["+0.000000", 0, 0n],
    ["5.000", 0, 5n],
    ["00012,3400", 2, 1234n],
  ];
  for (const [value, scale, expected] of examples) {
    assert.equal(decimal(value, scale), expected, value);
  }
});

test("significant extra digits and out-of-range integers remain invalid", () => {
  for (const value of ["24.001", "12.3400100", "0.0001000"]) {
    assert.throws(() => decimal(value, 2), /decimal-precision/, value);
  }
  assert.throws(() => decimal("5.100", 0), /decimal-precision/);
  assert.throws(() => decimal("100.0000", 2, 4), /decimal-precision/);
  assert.equal(decimal("00012.3400", 2, 4), 1234n);
  for (const value of ["1e2", "NaN", "Infinity", "1.000,00", ""]) {
    assert.throws(() => decimal(value, 2), /invalid-decimal/, value);
  }
});

test("item calculations keep their commercial rounding after normalization", () => {
  assert.equal(itemAmount("1.0000", "1.9950000", "0.0000000"), "2.00");
  assert.equal(itemAmount("-1.0000", "1.9950000"), "-2.00");
});

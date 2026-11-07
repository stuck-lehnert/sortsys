import { formatMeasureLimit } from "./takeoffLabels";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addMeasures,
  calculateMeasurement,
  evaluateMeasure,
  measureDecimal,
  measurementInput,
  measurementResult,
  newMeasurement,
  rebAddress,
  rebMeasureRow,
  rebResult,
} from "./takeoff";

describe("assisted measurements", () => {
  for (const [shape, patch, expected] of [
    ["count", { count: "7" }, "7.000"],
    ["length", { count: "4", a: "2,35" }, "9.400"],
    ["area", { count: "1", a: "1,455", b: "1,535" }, "2.233"],
    ["volume", { count: "2", a: "3.2", b: "2.5", c: "0.4" }, "6.400"],
    ["triangle", { count: "2", a: "4", b: "3" }, "12.000"],
    ["trapezoid", { count: "1", a: "3", b: "5", c: "2" }, "8.000"],
    ["factor", { count: "4", a: "0.3", b: "1.83", factor: ",67" }, "1.471"],
    ["formula", { count: "2", expression: "(1,2 + 0,8) x 3" }, "12.000"],
    ["length", { count: "4", a: "2*1.5+0.8", mode: "deduct" }, "-15.200"],
  ] as const)
    test(`${shape} evaluates dimensions and repeat count (${expected})`, () => {
      const row = { ...newMeasurement(shape, "example"), ...patch };
      assert.equal(measureDecimal(calculateMeasurement(row).result), expected);
      const native = rebMeasureRow(row, "0001A0");
      assert.equal(native.length, 80);
      assert.equal(native.slice(0, 11), " ".repeat(11));
      assert.equal(native.slice(29, 31), "91");
      assert.equal(native.slice(69, 75), "0001A0");
      assert.equal(measureDecimal(rebResult(native)!), expected);
    });
  test("workbook arch notation separates the factor from the repeat count", () => {
    assert.equal(measureDecimal(evaluateMeasure("(,67x4)")), "2.680");
    const arch = {
      ...newMeasurement("factor", "arch"),
      a: ".3",
      b: "1.83",
      count: "4",
      factor: ".67",
    };
    assert.equal(
      measureDecimal(calculateMeasurement(arch).result, 5),
      "1.47132",
    );
  });
  for (const [a, skipped] of [
    ["2.499", true],
    ["2.500", true],
    ["2.501", false],
  ] as const)
    test(`opening threshold applies to each opening of ${a} m²`, () => {
      const row = {
        ...newMeasurement("area", "opening"),
        mode: "opening" as const,
        a: String(a),
        b: "1",
        count: "10",
        threshold: "2.5",
      };
      const calc = calculateMeasurement(row);
      assert.equal(calc.overmeasured, skipped);
      assert.equal(measureDecimal(calc.result), skipped ? "0.000" : "-25.010");
      assert.equal(
        measureDecimal(rebResult(rebMeasureRow(row, "0001A0"))!),
        measureDecimal(calc.result),
      );
    });
  test("small surfaces and ordinary deductions are not automatically overmeasured", () => {
    const row = {
      ...newMeasurement("area", "small"),
      a: "1",
      b: "1",
      threshold: "2.5",
    };
    assert.equal(measureDecimal(calculateMeasurement(row).result), "1.000");
    assert.equal(
      measureDecimal(calculateMeasurement({ ...row, mode: "deduct" }).result),
      "-1.000",
    );
    assert.equal(
      measureDecimal(
        calculateMeasurement({ ...row, mode: "opening", threshold: "" }).result,
      ),
      "-1.000",
    );
  });
  test("2009 sums exact fractions before rounding; 1979 rounds each approach", () => {
    const row = {
      ...newMeasurement("formula", "fraction"),
      expression: "1/16",
    };
    assert.equal(
      measureDecimal(
        addMeasures(measurementResult(row), measurementResult(row)),
      ),
      "0.125",
    );
    assert.equal(
      measureDecimal(
        addMeasures(measurementResult(row, true), measurementResult(row, true)),
      ),
      "0.126",
    );
  });
  for (const expression of [
    "1/0",
    "2**3",
    "2..4",
    "1+",
    "alert(1)",
    "process.env",
    "(2+3",
    "1e20",
    "1;2",
  ])
    test(`rejects unsafe or incomplete formula ${expression}`, () => {
      assert.throws(() => evaluateMeasure(expression));
    });
  test("negative dimensions and opening thresholds for lengths are rejected", () => {
    assert.throws(
      () =>
        calculateMeasurement({
          ...newMeasurement("length", "negative"),
          a: "-2",
        }),
      /takeoff-negative-dimension/,
    );
    assert.throws(
      () =>
        calculateMeasurement({
          ...newMeasurement("length", "opening"),
          mode: "opening",
        }),
      /takeoff-opening-area/,
    );
  });
  test("long expressions use an exact rational in the native FN91 field", () => {
    const row = {
      ...newMeasurement("formula", "long"),
      expression: "0.001+0.001+0.001+0.001+0.001+0.001+0.001+0.001+0.001+0.001",
    };
    assert.equal(rebMeasureRow(row, "0001A0").slice(31, 69).trim(), "1/100=");
  });
  test("REB addresses are unique across sheet, line and continuation digit", () => {
    assert.equal(
      new Set(Array.from({ length: 1000 }, (_, i) => rebAddress(i))).size,
      1000,
    );
    assert.equal(rebAddress(259), "0001Z9");
    assert.equal(rebAddress(260), "0002A0");
  });
});

test("decimal fields use locale separators and retain precision beyond three decimal places", () => {
  assert.equal(measurementInput("2", "de"), "2,000");
  assert.equal(measurementInput("2.5", "de"), "2,500");
  assert.equal(measurementInput(",67", "de"), "0,670");
  assert.equal(measurementInput("0.00123", "de"), "0,00123");
  assert.equal(measurementInput("2,5", "en"), "2.500");
  assert.equal(measurementInput("2*1.5", "de"), "2*1,5");
});

test("overmeasured openings retain their readable dimensions while REB stays executable", () => {
  const row = {
    ...newMeasurement("area", "window"),
    a: "1,2",
    b: "1,5",
    count: "4",
    mode: "opening" as const,
    threshold: "2,5",
  };
  const result = calculateMeasurement(row);
  assert.equal(result.baseExpression, "4*(1.2*1.5)");
  assert.equal(measureDecimal(result.result), "0.000");
  assert.match(result.expression, /^0\*/);
});

test("opening limits use consistent localized precision", () => {
  assert.equal(formatMeasureLimit("2.5", "de"), "2,50");
  assert.equal(formatMeasureLimit("2,5", "en"), "2.50");
  assert.equal(formatMeasureLimit("2.125", "de"), "2,125");
});

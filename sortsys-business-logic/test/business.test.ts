import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDecimal,
  formatEuro,
  compareBusinessText,
  canRole,
  upmatchUnit,
  regieProductTitle,
  userFullName,
  startOfIsoWeek,
  dayInIsoWeek,
  weekdayIndexInIsoWeek,
  isoWeekInfo,
  createPdfBusinessContext,
  createPdfTableBuilders,
} from "../src/index.ts";

test("PDF decimal rounding and EUR formatting have fixed DE/EN semantics", () => {
  assert.equal(formatDecimal(1234.56789, "de", 2, 4), "1.234,5679");
  assert.equal(formatDecimal(1234.5, "en", 2, 4), "1,234.50");
  assert.equal(formatEuro(1.005, "de"), "1,01\u00a0€");
  assert.equal(formatEuro(-1.005, "en"), "-€1.01");
  assert.equal(formatDecimal(1e-8, "de"), "0");
  assert.equal(formatDecimal(1e21, "en"), "1,000,000,000,000,000,000,000");
  assert.throws(() => formatEuro(Infinity, "de"), /INVALID_NUMBER/);
  assert.throws(() => formatDecimal(NaN, "en"), /INVALID_NUMBER/);
});
test("PDF dates and source never depend on the machine timezone or Intl number data", () => {
  const old = process.env.TZ;
  const original = Intl.NumberFormat;
  try {
    Object.defineProperty(Intl, "NumberFormat", {
      value: () => {
        throw new Error("Platform Intl must not format PDF values");
      },
      configurable: true,
    });
    const sources = [
      "Pacific/Honolulu",
      "Europe/Berlin",
      "Pacific/Auckland",
    ].map((zone) => {
      process.env.TZ = zone;
      const context = createPdfBusinessContext("de");
      assert.equal(
        context.formatDate(new Date("2026-01-01T00:00:00Z"), "long"),
        "1. Januar 2026",
      );
      const document = createPdfTableBuilders("de").buildTablePdfDocument({
        title: "Test",
        headers: ["Quantity"],
        rows: [[context.formatNumber(1.25)]],
      });
      document.exportedAt = new Date("2026-01-01T00:00:00Z");
      return context.buildPdfBatchDocument({ documents: [document] }, null);
    });
    assert.equal(sources[0], sources[1]);
    assert.equal(sources[1], sources[2]);
  } finally {
    Intl.NumberFormat = original;
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});
test("ISO week boundaries and local DST indexing use civil calendar days", () => {
  assert.deepEqual(isoWeekInfo(new Date("2021-01-01T00:00:00Z"), "UTC"), {
    isoYear: 2020,
    weekNumber: 53,
  });
  assert.equal(
    startOfIsoWeek(new Date("2026-01-01T00:00:00Z"), "UTC").toISOString(),
    "2025-12-29T00:00:00.000Z",
  );
  const old = process.env.TZ;
  try {
    process.env.TZ = "Europe/Berlin";
    const monday = new Date(2026, 2, 23);
    assert.equal(weekdayIndexInIsoWeek(dayInIsoWeek(monday, 6), monday), 6);
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
});
test("shared product names and source units preserve existing quarter-unit rules", () => {
  assert.equal(
    regieProductTitle({
      name: "Internal",
      brand: "Brand",
      regieReportName: "  Visible  ",
    }),
    "Visible",
  );
  assert.equal(
    regieProductTitle({
      name: "Product",
      brand: "Brand",
      regieReportName: " ",
    }),
    "Brand Product",
  );
  assert.deepEqual(
    upmatchUnit({ baseUnit: "kg", otherUnits: { bag: 20 } }, 25),
    [1.25, "bag"],
  );
  assert.deepEqual(
    upmatchUnit({ baseUnit: "kg", otherUnits: { bad: Infinity } }, 25),
    [25, "kg"],
  );
  assert.equal(
    userFullName({ firstName: "Ada", lastName: "Example" }),
    "Ada Example",
  );
  assert.equal(compareBusinessText("Änne", "anne"), 0);
});
test("client visibility policies preserve explicit mobile roles and the web manage policy", () => {
  assert.equal(canRole(["manage:projects"], "view:projects"), false);
  assert.equal(
    canRole(["manage:projects"], "view:projects", { manageImpliesView: true }),
    true,
  );
  assert.equal(
    canRole(["view:projects"], "manage:projects", { manageImpliesView: true }),
    false,
  );
  assert.equal(canRole([], "view:projects"), false);
  assert.equal(canRole([":admin"], "manage:projects"), true);
});

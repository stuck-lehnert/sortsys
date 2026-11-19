import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { calendarDay, calendarWeek, addCalendarDays } from "./calendarDays";
import { indexHistoricalPrices } from "./historicalPrices";
import {
  regieCollection,
  regiePayload,
  regieHours,
  regieChanges,
  regieMaterialCosts,
  wireRegie,
} from "./regieReportData";
import { regieReportForm } from "../regieReportForm";

export function regieFixture() {
  return {
    value: {
      format: "sortsys-regie-report-v1",
      report: row("regie_reports", {
        id: "3",
        project_id: "2",
        day: "2026-08-24",
        summary: "Zusätzliche Abdichtung",
      }),
      products: [
        row("regie_report_products", {
          id: "4",
          report_id: "3",
          product_id: "6",
          quantity: 2.375,
          comment: "Sonderfarbe",
        }),
      ],
      specials: [
        row("regie_report_special_records", {
          id: "5",
          report_id: "3",
          name: "Entsorgung",
          unit: "Stk",
          amount: 1.125,
          comment: "Getrennt entsorgen",
        }),
      ],
    },
    hours: {
      format: "sortsys-regie-hours-v1",
      projectId: "2",
      reportId: "3",
      week: "2026-08-24",
      hours: [
        row("regie_report_work_hours", {
          id: "8",
          report_id: "3",
          user_id: null,
          hours: 7.375,
          day: "2026-08-25",
        }),
      ],
    },
  };
}
test("calendar dates retain the stated day across offsets, week boundaries and daylight-saving changes", () => {
  expect(calendarDay("2026-10-26T00:00:00.000+01:00")).toBe("2026-10-26");
  expect(calendarWeek("2026-10-25")).toBe("2026-10-19");
  expect(calendarWeek("2026-01-01")).toBe("2025-12-29");
  expect(addCalendarDays("2026-10-25", 1)).toBe("2026-10-26");
  for (const day of [
    "2026-02-30",
    "2026-02-30T00:00:00.000+01:00",
    "2026-10-25T25:00:00Z",
    new Date(NaN),
  ])
    expect(() => calendarDay(day)).toThrow();
});
test("regie quantities and working time have independent strict project/report/week bindings", () => {
  const { value, hours } = regieFixture(),
    area = regieCollection("2"),
    times = regieCollection("2", true);
  expect(regiePayload(value, area.prefix + "3", "2")).toEqual(value);
  expect(regieHours(hours, times.prefix + "3", "2")).toEqual(hours);
  expect(wireRegie(value, hours, 12).workHours[0].hours).toBe(7.375);
  expect(wireRegie(value, undefined, 12).workHours).toEqual([]);
  for (const change of [
    (p) => (p.report.values.project_id = "7"),
    (p) => (p.products[0].values.report_id = "7"),
    (p) => p.products.push(p.products[0]),
    (p) => (p.hours = []),
    (p) => (p.report.values.day = "2026-08-25"),
  ]) {
    const p = structuredClone(value);
    change(p);
    expect(() => regiePayload(p, area.prefix + "3", "2")).toThrow();
  }
  for (const change of [
    (p) => (p.projectId = "7"),
    (p) => (p.reportId = "7"),
    (p) => (p.hours[0].values.day = "2026-08-31"),
    (p) => (p.hours[0].values.hours = 11),
    (p) => p.hours.push(p.hours[0]),
  ]) {
    const p = structuredClone(hours);
    change(p);
    expect(() => regieHours(p, times.prefix + "3", "2")).toThrow();
  }
  expect(() => wireRegie(value, { ...hours, week: "2026-08-17" }, 1)).toThrow();
});
test("regie material costs use exact historical prices at the end-of-week cutoff without future fallback", () => {
  const { value, hours } = regieFixture(),
    report = wireRegie(value, hours, 1);
  const price = (id, timestamp, amount) =>
    row("product_price_records", {
      id,
      product_id: "6",
      timestamp,
      price: amount,
    });
  const prices = indexHistoricalPrices([
    price("10", "2026-08-31T00:00:00.000001Z", 999),
    price("11", "2026-08-31T00:00:00Z", 23.456789),
    price("12", "2026-08-31T01:00:00+01:00", 24.987654321),
  ]);
  const result = regieMaterialCosts(report, prices);
  expect(result.products[0].priceRecord.id).toBe("c");
  expect(result.totalCost).toBe(2.375 * 24.987654321);
  const future = indexHistoricalPrices([price("10", "2026-09-01T00:00:00Z", 999)]);
  expect(regieMaterialCosts(report, future).products[0].priceRecord).toBeNull();

  const overflow = indexHistoricalPrices([
    price("10", "2026-08-30T00:00:00Z", Number.MAX_VALUE),
  ]);
  expect(() => regieMaterialCosts(report, overflow)).toThrow();
});
test("regie patches distinguish omitted areas from clearing and reject unbound identities and numbers", () => {
  expect(regieChanges({ summary: " Noch abzudichten " }, false)).toEqual({
    summary: "Noch abzudichten",
  });
  expect(regieChanges({ workHours: null }, false)).toEqual({ hours: [] });
  expect(
    regieChanges(
      {
        day: "2026-08-25T00:00:00.000+02:00",
        workHours: [{ day: "2026-08-26", hours: 1.25 }],
      },
      false,
    ),
  ).toMatchObject({
    day: "2026-08-24",
    hours: [{ day: "2026-08-26", hours: 1.25 }],
  });
  for (const input of [
    {},
    { workHours: [{ id: "8", hours: NaN, day: "2026-08-25" }] },
    { workHours: [{ hours: 11, day: "2026-08-25" }] },
    { products: [{ productId: "06", quantity: 1 }] },
    { specialRecords: [{ name: "", unit: "Stk", amount: 1 }] },
  ])
    expect(() => regieChanges(input, false)).toThrow();
});
test("one form conversion preserves line IDs/comments, converts units and omits unreadable portions", () => {
  const f = regieFixture(),
    report = wireRegie(f.value, f.hours, 1),
    week = new Date("2026-08-24T12:00:00Z");
  const values = {
    week,
    summary: "Geändert",
    "record:4:product": [{ id: "6", baseUnit: "kg", otherUnits: { Sack: 25 } }],
    "record:4:unit": "Sack",
    "record:4:amount": "2,5",
    "specialRecord:5:name": "Entsorgung",
    "specialRecord:5:unit": "Stk",
    "specialRecord:5:amount": "1,125",
    "workHour:8:dayIndex": "1",
    "workHour:8:hours": "7,375",
  };
  const all = regieReportForm(values, { material: true, hours: true }, report);
  expect(all.products[0]).toEqual({
    id: "4",
    productId: "6",
    quantity: 62.5,
    comment: "Sonderfarbe",
  });
  expect(all.specialRecords[0].comment).toBe("Getrennt entsorgen");
  expect(all.workHours[0].id).toBe("8");
  const material = regieReportForm(
    values,
    { material: true, hours: false },
    report,
  );
  expect(Object.hasOwn(material, "workHours")).toBe(false);
  expect(Object.hasOwn(material, "day")).toBe(false);
  const times = regieReportForm(
    values,
    { material: false, hours: true },
    report,
  );
  expect(Object.keys(times)).toEqual(["workHours"]);
  const hidden = regieReportForm(
    { ...values, "record:4:product": [], "record:4:unit": "" },
    { material: true, hours: false },
    report,
  );
  expect(hidden.products[0]).toMatchObject({
    id: "4",
    productId: "6",
    quantity: 2.5,
  });
});

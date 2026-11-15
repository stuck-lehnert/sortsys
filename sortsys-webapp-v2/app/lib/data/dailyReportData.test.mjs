import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import {
  dailyCollection,
  dailyCosts,
  dailyPayload,
  DAILY_MODEL,
  DAILY_COST_MODEL,
  calendarDay,
  reportHours,
  wireDailyReport,
} from "./dailyReportData";
import { aggregateRows, existingAggregateRows } from "./aggregateRows";
import { openDataDocument, UNLOADED } from "./runtime/model";
import { DataRow, projectDataRows } from "./runtime/rows";
import { permittedReportHours } from "../dailyReportHours";
import {
  PROJECT_FACETS,
  projectFacetArea,
  projectFacetDomain,
} from "./projectScope";

export function reportFixture() {
  return {
    format: "sortsys-daily-report-v1",
    report: row("daily_project_reports", {
      id: "3",
      project_id: "2",
      day: "2026-08-25",
      summary: "Fensterlaibungen hergestellt",
      weather: '{"temperatureC":17.25}',
    }),
    hours: [
      row("daily_project_report_work_hours", {
        id: "4",
        report_id: "3",
        user_id: null,
        hours: 7.375,
        cost_per_hour: null,
        contract_type: "external",
      }),
    ],
    photos: [],
  };
}
test("aggregate validation binds child identities to their document and refuses invented replacement IDs", () => {
  const value = reportFixture(),
    hours = value.hours;
  expect(
    aggregateRows(hours, "daily_project_report_work_hours", "report_id", "3"),
  ).toEqual(hours);
  for (const changes of [
    [{ id: "4" }, { id: "4" }],
    [{ id: "5" }],
    [{ id: "04" }],
  ])
    expect(() => existingAggregateRows(hours, changes)).toThrow();
  expect(existingAggregateRows(hours, [{ id: "4" }, {}]).get("4")).toEqual(
    hours[0],
  );
  expect(() =>
    aggregateRows([...hours, ...hours], hours[0].table, "report_id", "3"),
  ).toThrow();
  expect(() =>
    aggregateRows(hours, hours[0].table, "report_id", "5"),
  ).toThrow();
});
test("daily report hours are independent of their internal costs and retain exact numeric values", () => {
  const area = dailyCollection("2"),
    money = dailyCollection("2", true),
    value = reportFixture(),
    costs = {
      format: "sortsys-daily-costs-v1",
      projectId: "2",
      reportId: "3",
      costs: [{ id: "4", costPerHour: 123.456789 }],
    };
  const opened = openDataDocument(DAILY_MODEL, area, {
    envelope: { object: area.prefix + "3", revision: "1" },
    value,
  });
  const p = new DataRow(
    [
      ...projectDataRows([opened])
        .get("daily_project_report_work_hours")
        .values(),
    ][0],
    () => {},
  );
  expect(p.require("hours")).toBe(7.375);
  expect(p.get("cost_per_hour")).toBe(UNLOADED);
  const secret = openDataDocument(DAILY_COST_MODEL, money, {
    envelope: { object: money.prefix + "3", revision: "1" },
    value: costs,
  });
  const full = new DataRow(
    [
      ...projectDataRows([opened, secret])
        .get("daily_project_report_work_hours")
        .values(),
    ][0],
    () => {},
  );
  expect(full.require("cost_per_hour")).toBe(123.456789);
  expect(wireDailyReport(value).workHours[0].costPerHour).toBeNull();
  expect(wireDailyReport(value, costs).workHours[0].costPerHour).toBe(
    123.456789,
  );
});
test("reports reject field injection, foreign children, mismatched costs and invalid dates", () => {
  const area = dailyCollection("2"),
    value = reportFixture();
  for (const change of [
    (p) => (p.report.values.project_id = "5"),
    (p) => (p.hours[0].values.report_id = "5"),
    (p) => (p.hours[0].values.cost_per_hour = 99),
    (p) => (p.hours[0].values.hours = Infinity),
    (p) => (p.hours[0].values.contract_type = "made-up"),
    (p) => (p.report.values.weather = '{"network":"secret"}'),
    (p) => (p.report.values.extra = 1),
  ]) {
    const copy = structuredClone(value);
    change(copy);
    expect(() => dailyPayload(copy, area.prefix + "3", "2")).toThrow();
  }
  expect(() => dailyPayload(value, area.prefix + "4", "2")).toThrow();
  expect(() =>
    dailyCosts(
      {
        format: "sortsys-daily-costs-v1",
        projectId: "5",
        reportId: "3",
        costs: [],
      },
      dailyCollection("2", true).prefix + "3",
      "2",
    ),
  ).toThrow();
  for (const day of ["2026-02-30", "2026-8-25", new Date(NaN), "whatever"])
    expect(() => calendarDay(day)).toThrow();
  expect(calendarDay(new Date("2026-08-25T00:00:00Z"))).toBe("2026-08-25");
});
test("forms omit uneditable costs, preserve stable IDs and distinguish omitted values from an explicit null", () => {
  const input = [
    { id: "4", hours: 7.375, costPerHour: 12.345 },
    { id: "5", hours: 2.25, costPerHour: null },
  ];
  expect(permittedReportHours(input, false)).toEqual([
    { id: "4", hours: 7.375 },
    { id: "5", hours: 2.25 },
  ]);
  expect(input[0].costPerHour).toBe(12.345);
  expect(permittedReportHours(input, true)).toEqual(input);
  expect(
    Object.hasOwn(
      reportHours([{ id: "4", hours: 2.25 }], false)[0],
      "costPerHour",
    ),
  ).toBe(false);
  expect(
    reportHours([{ id: "4", hours: 2.25, costPerHour: null }], false)[0]
      .costPerHour,
  ).toBeNull();
  expect(() => reportHours(input, true)).toThrow();
  expect(() => reportHours([input[0], input[0]], false)).toThrow();
});
test("all project facets use one canonical resource binding", () => {
  for (const facet of PROJECT_FACETS) {
    const area = projectFacetArea("2", facet);
    expect(projectFacetDomain(area.domain)).toEqual({ id: "2", facet });
  }
  expect(projectFacetDomain("project:2:measurement")).toBeNull();
  expect(projectFacetDomain("project:02:personnel")).toBeNull();
  expect(() => projectFacetArea("0", "personnel")).toThrow();
  expect(() => projectFacetArea("2", "measurement")).toThrow();
});

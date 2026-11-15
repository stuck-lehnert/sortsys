import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import {
  PERSONNEL_MODEL,
  PERSONNEL_FACETS,
  personnelCollection,
  personnelPart,
  personnelDomain,
  personnelChanges,
  newPersonnelProfile,
} from "./personnelData";
import { openDataDocument, UNLOADED } from "./runtime/model";
import { DataRow, projectDataRows } from "./runtime/rows";

const source = () =>
  row("users", {
    id: "100",
    username: "anna.muster",
    first_name: "Anna",
    last_name: "Muster",
    contract_type: "internal",
    ui_locale: "de",
    cost_per_hour: 73.87654321,
    vacation_days_per_year: "30",
    supervisor_user_id: "101",
  });
function opened(facet) {
  const area = personnelCollection("34", facet);
  return openDataDocument(PERSONNEL_MODEL, area, {
    envelope: { object: area.prefix, revision: "1" },
    value: personnelPart(source(), facet),
  });
}
test("personnel names, employment data and internal hourly costs have independent field ownership", () => {
  const master = opened("master-data"),
    employment = opened("scope"),
    costs = opened("calculation");
  expect(Object.hasOwn(master.value.values, "ui_locale")).toBe(false);
  expect(JSON.stringify(master.value)).not.toContain("cost_per_hour");
  expect(JSON.stringify(master.value)).not.toContain("supervisor_user_id");
  expect(JSON.stringify(master.value)).not.toContain("vacation_days_per_year");
  const publicRow = new DataRow(
    [...projectDataRows([master]).get("users").values()][0],
    () => {},
  );
  expect(publicRow.require("first_name")).toBe("Anna");
  expect(publicRow.get("cost_per_hour")).toBe(UNLOADED);
  expect(publicRow.get("vacation_days_per_year")).toBe(UNLOADED);
  expect(publicRow.get("ui_locale")).toBe(UNLOADED);
  const full = new DataRow(
    [...projectDataRows([master, employment, costs]).get("users").values()][0],
    () => {},
  );
  expect(full.require("cost_per_hour")).toBe(73.87654321);
  expect(full.require("vacation_days_per_year")).toBe("30");
  expect(full.require("supervisor_user_id")).toBe("101");
  const privateRow = new DataRow(
    [...projectDataRows([costs]).get("users").values()][0],
    () => {},
  );
  expect(privateRow.require("cost_per_hour")).toBe(73.87654321);
  expect(privateRow.get("first_name")).toBe(UNLOADED);
});
test("personnel parts reject resource substitution, private-field injection and invalid schema values", () => {
  for (const facet of PERSONNEL_FACETS) {
    const area = personnelCollection("34", facet),
      original = personnelPart(source(), facet);
    expect(() =>
      PERSONNEL_MODEL.decode({ ...original, id: "35" }, area.prefix, area),
    ).toThrow();
    expect(() =>
      PERSONNEL_MODEL.decode(original, area.prefix, {
        ...area,
        scope: "personnel:35",
      }),
    ).toThrow();
    expect(() =>
      PERSONNEL_MODEL.decode(
        { ...original, values: { ...original.values, id: "101" } },
        area.prefix,
        area,
      ),
    ).toThrow();
    expect(() =>
      PERSONNEL_MODEL.decode(
        { ...original, values: { ...original.values, password: "private" } },
        area.prefix,
        area,
      ),
    ).toThrow();
  }
  const master = opened("master-data");
  expect(() =>
    PERSONNEL_MODEL.decode(
      { ...master.value, values: { ...master.value.values, cost_per_hour: 1 } },
      master.area.prefix,
      master.area,
    ),
  ).toThrow();
  expect(() =>
    personnelPart(
      row("users", { ...source().values, cost_per_hour: -1 }),
      "calculation",
    ),
  ).toThrow();
  expect(() =>
    personnelPart(
      row("users", { ...source().values, vacation_days_per_year: "367" }),
      "scope",
    ),
  ).toThrow();
  expect(() =>
    personnelPart(
      row("users", { ...source().values, supervisor_user_id: "100" }),
      "scope",
    ),
  ).toThrow();
  expect(() =>
    personnelPart(
      row("users", { ...source().values, first_name: " " }),
      "master-data",
    ),
  ).toThrow();
  expect(personnelDomain("personnel:34:master-data")).toEqual({
    id: "34",
    facet: "master-data",
  });
  expect(personnelDomain("personnel:34:procurement")).toBeNull();
  expect(() => personnelCollection("0", "scope")).toThrow();
});
test("personnel patches validate numeric values and preserve absent private fields", () => {
  expect(personnelChanges({ firstName: " Anna ", lastName: "" })).toEqual({
    first_name: "Anna",
    last_name: null,
  });
  expect(personnelChanges({ costPerHour: 73.87654321 })).toEqual({
    cost_per_hour: 73.87654321,
  });
  expect(
    personnelChanges({ vacationDaysPerYear: 30, supervisorUserId: "35" }),
  ).toEqual({ vacation_days_per_year: "30", supervisor_user_id: "101" });
  for (const invalid of [
    { costPerHour: "73,50" },
    { costPerHour: NaN },
    { costPerHour: -1 },
    { vacationDaysPerYear: 1.5 },
    { vacationDaysPerYear: 367 },
    { firstName: "" },
    { roles: [":admin"] },
    { deactivatedAt: null },
  ])
    expect(() => personnelChanges(invalid)).toThrow();
});
test("new profiles validate the same schema without accepting credential or extra fields", () => {
  const profile = (changes) =>
    newPersonnelProfile(
      "34",
      "anna.muster",
      "2026-11-12T01:00:00Z",
      "1",
      "de",
      changes,
    );
  expect(
    profile({ first_name: "Anna", cost_per_hour: 73.87654321 }).values
      .cost_per_hour,
  ).toBe(73.87654321);
  expect(() => profile({ password: "forbidden" })).toThrow();
  expect(() => profile({ first_name: "" })).toThrow();
  expect(() => profile({ cost_per_hour: -1 })).toThrow();
});

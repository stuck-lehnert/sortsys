import { describe, expect, test } from "bun:test";
import {
  addRecentPlanningProjects,
  clipAssignments,
  prefillPlanningSelection,
} from "./deploymentPlanning.ts";
import { groupBy } from "./groupBy.ts";

function project(id, finishedAt = null) {
  return { id, title: `Project ${id}`, finishedAt };
}

function row(id) {
  return { id, label: `Planned ${id}` };
}

function ids(rows) {
  return rows.map((item) => item.id);
}

function picker() {
  let value = [];
  let mounted = true;

  const field = {
    getValue: () => value,
    setValue: (next) => {
      value = next;
    },
  };

  return {
    field,
    form: { field: () => (mounted ? field : null) },
    close() {
      mounted = false;
    },
  };
}

test("planning prefills cached and missing selections without a redundant read", async () => {
  const cached = picker();
  const original = project("original");
  const read = async () => {
    throw new Error("unexpected project read");
  };

  await prefillPlanningSelection(cached.form, "project", original.id, [original], read);
  expect(cached.field.getValue()).toEqual([original]);

  const uncached = picker();
  const { promise, resolve } = Promise.withResolvers();
  const pending = prefillPlanningSelection(
    uncached.form,
    "project",
    original.id,
    [],
    () => promise,
  );
  expect(uncached.field.getValue()).toEqual([]);

  resolve([original, null]);
  await pending;
  expect(uncached.field.getValue()).toEqual([original]);
});

test.each(["selected", "cleared", "closed"])(
  "a pending planning preset leaves a %s picker alone",
  async (state) => {
    const selection = picker();
    const original = project("original");
    const replacement = project("replacement");
    const { promise, resolve } = Promise.withResolvers();
    const pending = prefillPlanningSelection(
      selection.form,
      "project",
      original.id,
      [],
      () => promise,
    );

    if (state === "closed") selection.close();
    else selection.field.setValue([replacement]);

    if (state === "cleared") selection.field.setValue([]);
    const current = selection.field.getValue();

    resolve([original, null]);
    await pending;
    expect(selection.field.getValue()).toBe(current);
  },
);

test("planning groups preserve encounter order without changing their input", () => {
  const periods = Object.freeze([
    { projectId: "2", from: "09:00" },
    { projectId: "1", from: "10:00" },
    { projectId: "2", from: "11:00" },
  ]);

  const groups = groupBy(periods, (period) => period.projectId);

  expect([...groups.keys()]).toEqual(["2", "1"]);
  expect(groups.get("2")).toEqual([periods[0], periods[2]]);
  expect(groups.get("1")).toEqual([periods[1]]);
});

test("assignment segments are clipped to the visible half-open interval", () => {
  const time = (hour) => new Date(Date.UTC(2026, 9, 27, hour));
  const earlier = { from: time(7), to: time(10) };
  const within = { from: time(10), to: time(11) };
  const later = { from: time(11), to: time(18) };
  const assignments = Object.freeze([
    { from: time(6), to: time(8) },
    earlier,
    within,
    { from: time(10), to: time(10) },
    later,
    { from: time(16), to: time(20) },
  ]);

  expect(clipAssignments(assignments, time(8), time(16))).toEqual([
    { item: earlier, start: time(8), end: time(10) },
    { item: within, start: time(10), end: time(11) },
    { item: later, start: time(11), end: time(16) },
  ]);
  expect(earlier.from).toEqual(time(7));
  expect(later.to).toEqual(time(18));
});

describe("additional recent active projects in deployment planning", () => {
  test("shows five rows without any existing plans and preserves activity order", () => {
    const projects = ["g", "b", "f", "a", "e", "c", "d"].map((id) =>
      project(id),
    );

    expect(ids(addRecentPlanningProjects([], projects))).toEqual([
      "g",
      "b",
      "f",
      "a",
      "e",
    ]);
  });

  test("adds five more projects rather than filling the total row count to five", () => {
    const rows = [row("a"), row("b"), row("c")];
    const projects = "abcdefghij".split("").map((id) => project(id));

    expect(ids(addRecentPlanningProjects(rows, projects))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });

  test("still adds five when more than five projects already have rows", () => {
    const rows = "abcdefg".split("").map(row);
    const projects = "abcdefghijklmn".split("").map((id) => project(id));

    expect(ids(addRecentPlanningProjects(rows, projects))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
    ]);
  });

  test("skips completed projects before applying the additional-row limit", () => {
    const projects = [
      project("completed", new Date("2026-01-01T00:00:00Z")),
      ..."abcdef".split("").map((id) => project(id)),
    ];

    expect(ids(addRecentPlanningProjects([], projects))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("does not count existing interruption rows toward the five suggestions", () => {
    const rows = [row("unavailable"), row("assigned")];
    const projects = [
      project("unavailable"),
      project("assigned"),
      ..."abcdef".split("").map((id) => project(id)),
    ];

    expect(ids(addRecentPlanningProjects(rows, projects))).toEqual([
      "unavailable",
      "assigned",
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("keeps completed and unavailable project labels already shown by planning", () => {
    const rows = [row("completed"), row("unavailable")];
    const projects = [
      project("completed", new Date("2026-01-01T00:00:00Z")),
      project("unavailable"),
      project("active"),
    ];

    expect(addRecentPlanningProjects(rows, projects)).toEqual([
      ...rows,
      { id: "active", label: "Project active" },
    ]);
  });

  test("shows fewer projects when fewer eligible projects exist", () => {
    expect(ids(addRecentPlanningProjects([], [project("only")]))).toEqual([
      "only",
    ]);
    expect(addRecentPlanningProjects([row("existing")], [])).toEqual([
      row("existing"),
    ]);
    expect(addRecentPlanningProjects([], [])).toEqual([]);
  });

  test("does not mutate inputs or add duplicate projects", () => {
    const existing = Object.freeze([Object.freeze(row("existing"))]);
    const projects = Object.freeze([
      Object.freeze(project("a")),
      Object.freeze(project("a")),
      Object.freeze(project("existing")),
      Object.freeze(project("b")),
    ]);

    expect(ids(addRecentPlanningProjects(existing, projects))).toEqual([
      "existing",
      "a",
      "b",
    ]);
    expect(existing).toHaveLength(1);
    expect(projects).toHaveLength(4);
  });
});

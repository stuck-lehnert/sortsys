import { describe, expect, test } from "bun:test";
import { addRecentPlanningProjects } from "./deploymentPlanning.ts";

function project(id, finishedAt = null) {
  return { id, title: `Project ${id}`, finishedAt };
}

function row(id) {
  return { id, label: `Planned ${id}` };
}

function ids(rows) {
  return rows.map((item) => item.id);
}

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

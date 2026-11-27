import { expect, test } from "bun:test";
import { selectPlanningProjectActivity } from "./activityData";

const project = (id, title, instant) => ({ id, title, instant });
const event = (resourceType, resourceId, contextId, instant) => ({
  item: { resourceType, resourceId, contextId },
  instant,
});

test("visible related activity can promote a project but cannot add an ineligible one", () => {
  const projects = [
    project("1", "Halle", 900n),
    project("2", "Neubau", 800n),
    project("3", "Umbau", 700n),
    project("4", "Schule", 600n),
    project("5", "Büro", 500n),
    project("6", "Praxis", 400n),
  ];
  const events = [
    event("dailyProjectReport", "17", "6", 950n),
    event("deliveryNote", "43", "6", 900n),
    event("project", "9", null, 850n),
    event("tool", "5", null, 800n),
    event("project", "5", null, 750n),
    event("project", "1", null, 50n),
  ];
  const { selected, complete } = selectPlanningProjectActivity(
    projects,
    events,
    { instant: 650n },
  );
  expect(selected.map(({ id }) => id)).toEqual(["6", "1", "2", "5", "3"]);
  expect(selected[1].instant).toBe(900n);
  expect(complete).toBe(true);
});

test("the last position is not final when unseen activity can still win a title tie", () => {
  const projects = [
    project("1", "Halle", 901n),
    project("2", "Neubau", 801n),
    project("3", "Umbau", 701n),
    project("4", "Schule", 601n),
    project("5", "Büro", 500n),
    project("6", "Anbau", 400n),
  ];
  const cutoff = { instant: 500n };
  expect(selectPlanningProjectActivity(projects, [], cutoff).complete).toBe(false);

  const { selected, complete } = selectPlanningProjectActivity(
    projects,
    [event("project", "6", null, 500n)],
    { instant: 499n },
  );
  expect(selected.at(-1).id).toBe("6");
  expect(complete).toBe(true);
});

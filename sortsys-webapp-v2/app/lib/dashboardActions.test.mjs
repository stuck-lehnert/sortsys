import { expect, test } from "bun:test";
import { pickQuickActions } from "./dashboardActions";

const offer = { id: "offers.create" };
const project = { id: "projects.create" };
const report = { id: "regieReports.create" };

const used = (action, second) => ({
  actionId: action.id,
  usedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
});

test("projects and offers keep separate counts in dashboard shortcuts", () => {
  const history = [used(project, 1), used(project, 2), used(offer, 3)];

  expect(pickQuickActions([offer, project, report], history)).toEqual([
    project,
    offer,
    report,
  ]);
});

test("history cannot make an unavailable action visible", () => {
  const history = [used(project, 1), used(offer, 2), used(report, 3)];

  expect(pickQuickActions([offer, report], history)).toEqual([report, offer]);
});

test("without history the dashboard can show available defaults", () => {
  expect(pickQuickActions([offer, report], null)).toEqual([offer, report]);
});

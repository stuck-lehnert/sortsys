import { expect, test } from "bun:test";
import { replaceProjectRole } from "@sortsys/zerotrust/sortsys";
import { projectAccessArea } from "../data/projectScope";
import {
  compileManagedAccess,
  hasAccess,
  inheritDataActions,
  patchAccessRules,
} from "./accessProfiles";
import {
  assignedProjectRole,
  projectRoleAccessAreas,
  projectRoles,
} from "./projectAccessPresets";

test("replacing a project template keeps individual grants, explicit denials, and other projects", () => {
  const subject = "user:2";
  const billing = projectAccessArea("3", "billing");
  const attachment = projectAccessArea("3", "attachment");
  const report = projectAccessArea("3", "daily-reports:master-data");
  const decisions = patchAccessRules([], subject, [
    { area: billing, patch: { read: true } },
    { area: attachment, patch: { read: false } },
  ]);
  const twoProjects = replaceProjectRole(decisions, subject, "5", "project-overview");
  const documentation = replaceProjectRole(
    twoProjects, subject, "3", "project-documentation",
  );
  const access = (rules) =>
    compileManagedAccess({ tenant: "test", version: "1", rules }, subject);

  expect(access(documentation)(attachment)).toEqual({ actions: ["create"] });
  expect(access(documentation)(billing)).toBe("read");
  expect(hasAccess(access(documentation)(report), "update")).toBe(true);

  const changed = replaceProjectRole(documentation, subject, "3", "project-overview");
  expect(assignedProjectRole(changed, subject, "3")).toBe("project-overview");
  expect(access(changed)(report)).toBe("none");

  const inherited = patchAccessRules(changed, subject, [
    { area: attachment, patch: inheritDataActions },
  ]);
  expect(access(inherited)(attachment)).toBe("read");
  const removed = replaceProjectRole(inherited, subject, "3", null);
  expect(assignedProjectRole(removed, subject, "3")).toBeNull();
  expect(assignedProjectRole(removed, subject, "5")).toBe("project-overview");
  expect(access(removed)(attachment)).toBe("none");
  expect(access(removed)(billing)).toBe("read");
});

test("the template area inventory excludes costs and stays within the selected project", () => {
  const areas = projectRoleAccessAreas("3", projectRoles);
  expect(areas.map(({ domain }) => domain).sort()).toEqual([
    "project:3:attachment",
    "project:3:daily-reports:master-data",
    "project:3:delivery-notes:master-data",
    "project:3:master-data",
    "project:3:planning:master-data",
    "project:3:regie-reports:master-data",
    "project:3:regie-reports:personnel",
  ]);
});

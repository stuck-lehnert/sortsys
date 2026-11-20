import {
  PROJECT_ROLES,
  projectRuleRole,
  type ProjectRole,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { projectAccessArea, type ProjectAccessKey } from "../data/projectScope";

export const projectRoles = Object.keys(PROJECT_ROLES) as ProjectRole[];

export function assignedProjectRole(
  rules: readonly Rule[],
  subject: string,
  projectId: string,
): ProjectRole | null {
  for (const rule of rules) {
    if (rule.subject !== subject) continue;
    const role = projectRuleRole(rule, projectId);
    if (role) return role;
  }
  return null;
}

function roleKeys(roles: readonly ProjectRole[]) {
  const keys = new Set<ProjectAccessKey>();
  for (const role of roles) {
    for (const [module, facet] of PROJECT_ROLES[role]) {
      const key = module ? `${module}:${facet}` : facet;
      keys.add(key as ProjectAccessKey);
    }
  }
  return keys;
}

export const projectRoleKeys: ReadonlySet<ProjectAccessKey> = roleKeys(projectRoles);

export function projectRoleAccessAreas(
  projectId: string,
  roles?: readonly ProjectRole[],
) {
  return [...(roles ? roleKeys(roles) : projectRoleKeys)].map((key) =>
    projectAccessArea(projectId, key),
  );
}

import { InvalidProtectedData } from "./encoding";
import { creationResource } from "./creation";
import { reconcilePolicyRules, type Action, type Rule } from "./core/policy";
import type { Facet } from "./objects";

const read = ["read"] as const;
const edit = ["read", "create", "update"] as const;
type RoleArea = readonly [string, Facet, readonly Action[]];
export const ORGANIZATION_ROLES = {
  "organization-office": [
    ["catalog:customers", "master-data", edit],
    ["catalog:contacts", "master-data", edit],
    ["catalog:products", "master-data", read],
  ],
  "organization-procurement": [
    ["catalog:products", "master-data", edit],
    ["catalog:vendors", "master-data", edit],
    ["catalog:products", "procurement", edit],
  ],
} as const satisfies Record<string, readonly RoleArea[]>;
export type OrganizationRole = keyof typeof ORGANIZATION_ROLES;
export const PROJECT_ROLES = {
  "project-overview": [
    ["", "master-data", read],
    ["", "attachment", read],
  ],
  "project-documentation": [
    ["", "master-data", read],
    ["", "attachment", ["read", "create"]],
    ["daily-reports", "master-data", edit],
    ["regie-reports", "master-data", edit],
  ],
  "project-management": [
    ["", "master-data", ["read", "update"]],
    ["", "attachment", edit],
    ["delivery-notes", "master-data", edit],
    ["daily-reports", "master-data", edit],
    ["regie-reports", "master-data", edit],
    ["regie-reports", "personnel", edit],
    ["planning", "master-data", edit],
  ],
} as const satisfies Record<string, readonly RoleArea[]>;
export type ProjectRole = keyof typeof PROJECT_ROLES;
export type RuleOrigin = "absence-default" | OrganizationRole | ProjectRole;
type ApplicationRule = Rule<Facet, RuleOrigin>;

export function isOrganizationRole(value: string): value is OrganizationRole {
  return Object.hasOwn(ORGANIZATION_ROLES, value);
}

export function isProjectRole(value: string): value is ProjectRole {
  return Object.hasOwn(PROJECT_ROLES, value);
}

export function organizationRoleRules(
  role: OrganizationRole,
  subject: string,
): ApplicationRule[] {
  return ORGANIZATION_ROLES[role].map(([scope, facet, actions]) => ({
    subject,
    scope,
    facet,
    actions: [...actions],
    effect: "allow",
    origin: role,
  }));
}

function projectRuleScope(projectId: string, module: string) {
  return module ? `project:${projectId}:${module}` : `project:${projectId}`;
}

export function projectRoleRules(
  role: ProjectRole,
  subject: string,
  projectId: string,
): ApplicationRule[] {
  if (
    !isProjectRole(role) ||
    creationResource(projectRuleScope(projectId, ""))?.id !== projectId
  )
    throw new InvalidProtectedData();
  return PROJECT_ROLES[role].map(([module, facet, actions]) => ({
    subject,
    scope: projectRuleScope(projectId, module),
    facet,
    actions: [...actions],
    effect: "allow",
    origin: role,
  }));
}

export function projectRuleRole(rule: ApplicationRule, projectId: string) {
  if (!rule.origin || !isProjectRole(rule.origin)) return null;
  const project = creationResource(rule.scope);
  return project?.namespace === "project" && project.id === projectId
    ? rule.origin
    : null;
}

export function replaceProjectRole(
  rules: readonly ApplicationRule[],
  subject: string,
  projectId: string,
  role: ProjectRole | null,
) {
  return reconcilePolicyRules(
    rules,
    role ? projectRoleRules(role, subject, projectId) : [],
    (rule) =>
      rule.subject === subject && projectRuleRole(rule, projectId) !== null,
  );
}

function roleBinding(rule: ApplicationRule): {
  role: OrganizationRole | ProjectRole;
  group: string;
  scope: string;
  areas: readonly RoleArea[];
} | null {
  const role = rule.origin;
  if (!role) return null;
  if (isOrganizationRole(role)) {
    return {
      role,
      group: role,
      scope: rule.scope,
      areas: ORGANIZATION_ROLES[role],
    };
  }
  if (isProjectRole(role)) {
    const project = creationResource(rule.scope);
    if (project?.namespace !== "project") throw new InvalidProtectedData();
    return {
      role,
      group: project.id,
      scope: project.module ?? "",
      areas: PROJECT_ROLES[role],
    };
  }
  return null;
}

export function validateAccessRoleRule(rule: ApplicationRule): boolean {
  const binding = roleBinding(rule);
  if (!binding) return false;
  const { scope, areas } = binding;
  const expected = areas.find(
    ([areaScope, facet]) => scope === areaScope && rule.facet === facet,
  );
  if (
    rule.effect !== "allow" ||
    !expected ||
    expected[2].length !== rule.actions.length ||
    !expected[2].every((action, index) => rule.actions[index] === action)
  )
    throw new InvalidProtectedData();
  return true;
}

export function validateAccessRoleSets(
  rules: readonly ApplicationRule[],
) {
  const assignments = new Map<
    string,
    {
      role: ProjectRole | OrganizationRole;
      expected: number;
      areas: Set<string>;
    }
  >();
  for (const rule of rules) {
    const binding = roleBinding(rule);
    if (!binding) continue;
    const key = `${rule.subject}\0${binding.group}`;
    const assignment = assignments.get(key) ?? {
      role: binding.role,
      expected: binding.areas.length,
      areas: new Set<string>(),
    };
    const area = `${rule.scope}\0${rule.facet}`;
    if (assignment.role !== binding.role || assignment.areas.has(area))
      throw new InvalidProtectedData();
    assignment.areas.add(area);
    assignments.set(key, assignment);
  }
  for (const { expected, areas } of assignments.values()) {
    if (areas.size !== expected)
      throw new InvalidProtectedData();
  }
}

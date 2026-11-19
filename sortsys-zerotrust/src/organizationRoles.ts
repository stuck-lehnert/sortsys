import { InvalidProtectedData } from "./encoding";
import type { Action, Rule } from "./core/policy";
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
export type RuleOrigin = "absence-default" | OrganizationRole;
type ApplicationRule = Rule<Facet, RuleOrigin>;

export function isOrganizationRole(value: string): value is OrganizationRole {
  return Object.hasOwn(ORGANIZATION_ROLES, value);
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

export function validateOrganizationRoleRule(
  rule: ApplicationRule,
  role: OrganizationRole,
) {
  const areas: readonly RoleArea[] = ORGANIZATION_ROLES[role];
  const expected = areas.find(
    ([scope, facet]) => rule.scope === scope && rule.facet === facet,
  );
  if (
    rule.effect !== "allow" ||
    !expected ||
    expected[2].length !== rule.actions.length ||
    !expected[2].every((action, index) => rule.actions[index] === action)
  )
    throw new InvalidProtectedData();
}

export function validateOrganizationRoleSets(
  rules: readonly ApplicationRule[],
) {
  const assignments = new Map<
    string,
    {
      role: OrganizationRole;
      areas: Set<string>;
    }
  >();
  for (const rule of rules) {
    if (!rule.origin || !isOrganizationRole(rule.origin)) continue;
    const key = `${rule.subject}\0${rule.origin}`;
    const assignment = assignments.get(key) ?? {
      role: rule.origin,
      areas: new Set<string>(),
    };
    const area = `${rule.scope}\0${rule.facet}`;
    if (assignment.areas.has(area)) throw new InvalidProtectedData();
    assignment.areas.add(area);
    assignments.set(key, assignment);
  }
  for (const { role, areas } of assignments.values()) {
    if (areas.size !== ORGANIZATION_ROLES[role].length)
      throw new InvalidProtectedData();
  }
}

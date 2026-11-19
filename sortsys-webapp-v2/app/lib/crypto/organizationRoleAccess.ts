import {
  InvalidProtectedData,
  isOrganizationRole,
  ORGANIZATION_ROLES,
  organizationRoleRules,
  reconcilePolicyRules,
  record,
  type OrganizationRole,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { MASTER_DATA_AREAS } from "./accessProfiles";

export const organizationRoles = Object.keys(
  ORGANIZATION_ROLES,
) as OrganizationRole[];
export type OrganizationRoleState = Record<OrganizationRole, boolean>;
export type OrganizationRolePatch = Partial<OrganizationRoleState>;

export function memberOrganizationRoles(
  rules: readonly Rule[],
  subject: string,
): OrganizationRoleState {
  const state: OrganizationRoleState = {
    "organization-office": false,
    "organization-procurement": false,
  };
  for (const rule of rules) {
    if (
      rule.subject === subject &&
      rule.origin &&
      isOrganizationRole(rule.origin)
    )
      state[rule.origin] = true;
  }
  return state;
}

export function parseOrganizationRolePatch(
  input: unknown,
): OrganizationRolePatch {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidProtectedData();
  const keys = Object.keys(input);
  const data = record(input, keys);
  const result: OrganizationRolePatch = {};
  for (const key of keys) {
    const enabled = data[key];
    if (!isOrganizationRole(key) || typeof enabled !== "boolean")
      throw new InvalidProtectedData();
    result[key] = enabled;
  }
  return result;
}

export function editOrganizationRoles(
  current: readonly Rule[],
  subject: string,
  patch: OrganizationRolePatch,
) {
  const changed = organizationRoles.filter((role) =>
    Object.hasOwn(patch, role),
  );
  const domains = new Set<string>();
  const desired = changed.flatMap((role) => {
    const rules = organizationRoleRules(role, subject);
    for (const { scope, facet } of rules) domains.add(`${scope}:${facet}`);
    return patch[role] ? rules : [];
  });
  const rules = reconcilePolicyRules(
    current,
    desired,
    (rule) =>
      rule.subject === subject &&
      !!rule.origin &&
      isOrganizationRole(rule.origin) &&
      changed.includes(rule.origin),
  );
  const areas = Object.values(MASTER_DATA_AREAS).filter((area) =>
    domains.has(area.domain),
  );
  if (areas.length !== domains.size) throw new InvalidProtectedData();
  return { rules, areas };
}

import { identifier, InvalidProtectedData, record, revision } from "./encoding";
import { FACETS } from "./objects";
import type { Facet } from "./objects";

export const ACTIONS = ["read", "create", "update", "delete", "approve", "grant"] as const;
export type Action = typeof ACTIONS[number];
export type Rule = {
  subject: string;
  scope: string;
  facet: Facet;
  actions: Action[];
  effect: "allow" | "deny";
};
export type Policy = { tenant: string; version: string; rules: Rule[] };

export function policy(input: unknown): Policy {
  const obj = record(input, ["tenant", "version", "rules"]);
  identifier(obj.tenant);
  revision(obj.version);
  if (!Array.isArray(obj.rules) || obj.rules.length > 10_000) throw new InvalidProtectedData();
  const rules = obj.rules.map(value => {
    const rule = record(value, ["subject", "scope", "facet", "actions", "effect"]);
    identifier(rule.subject);
    identifier(rule.scope);
    if (!FACETS.includes(rule.facet as Facet) || !["allow", "deny"].includes(rule.effect as string)
      || !Array.isArray(rule.actions) || !rule.actions.length || rule.actions.length > ACTIONS.length
      || rule.actions.some(action => !ACTIONS.includes(action)) || new Set(rule.actions).size !== rule.actions.length) {
      throw new InvalidProtectedData();
    }
    return { ...rule, actions: [...rule.actions] } as Rule;
  });
  return { tenant: obj.tenant, version: obj.version, rules };
}

/** Scope inheritance must be resolved into signed rules, never guessed from UI parentage. */
export function allows(input: Policy, request: { tenant: string; version: string; subjects: readonly string[]; scope: string; facet: Facet; action: Action }): boolean {
  const current = policy(input);
  if (current.tenant !== request.tenant || current.version !== request.version) return false;
  let allowed = false;
  for (const rule of current.rules) {
    if (!request.subjects.includes(rule.subject) || rule.scope !== request.scope || rule.facet !== request.facet || !rule.actions.includes(request.action)) continue;
    if (rule.effect === "deny") return false;
    allowed = true;
  }
  return allowed;
}

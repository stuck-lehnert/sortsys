import { expect, test } from "bun:test";
import { ACTIONS, allows, compilePolicy, policy } from "../src/sortsys";
import type { Policy } from "../src/sortsys";

const rules: Policy = {
  tenant: "test", version: "1", rules: [
    { subject: "group:measure", scope: "project:123", facet: "scope", effect: "allow", actions: ["read"] },
    { subject: "group:measure", scope: "project:123", facet: "measurement", effect: "allow", actions: ["read", "create", "update"] },
    { subject: "user:1", scope: "project:123", facet: "measurement", effect: "deny", actions: ["delete"] },
  ],
};
const request = { tenant: "test", version: "1", subjects: ["user:1", "group:measure"], scope: "project:123", facet: "measurement", action: "update" } as const;

test("measurement edits do not grant price access, deletion, approval or delegation", () => {
  expect(allows(rules, request)).toBe(true);
  expect(allows(rules, { ...request, facet: "calculation", action: "read" })).toBe(false);
  for (const action of ["delete", "approve", "grant"] as const) expect(allows(rules, { ...request, action })).toBe(false);
  expect(allows(rules, { ...request, scope: "project:other" })).toBe(false);
  expect(allows(rules, { ...request, tenant: "other" })).toBe(false);
  expect(allows(rules, { ...request, version: "2" })).toBe(false);
});

test("explicit denial wins over group permissions without affecting a different action", () => {
  const current = policy(rules);
  current.rules.push({ subject: "user:1", scope: "project:123", facet: "measurement", effect: "deny", actions: ["update"] });
  expect(allows(current, request)).toBe(false);
  expect(allows(current, { ...request, action: "read" })).toBe(true);
});

test("policy schema fails closed and does not infer UI hierarchy", () => {
  expect(() => policy({ ...rules, admin: true })).toThrow();
  expect(() => policy({ ...rules, rules: [{ ...rules.rules[0], conditions: { admin: true } }] })).toThrow();
  expect(() => policy({ ...rules, rules: [{ ...rules.rules[0], actions: ["unknown"] }] })).toThrow();
  expect(allows(rules, { ...request, scope: "project:123/child" })).toBe(false);
});

test("compiled permissions match exact rule semantics for every action across users and groups", () => {
  const subjects = ["user:1", "group:measure", "user:else"], scopes = ["project:123", "project:123/child", "project:999"], facets = ["scope", "measurement", "procurement"] as const;
  const generated: Policy = { tenant: "test", version: "9", rules: [] };
  let seed = 711;
  const pick = <T>(values: readonly T[]): T => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return values[seed % values.length]!; };
  for (let i = 0; i < 80; i++) generated.rules.push({ subject: pick(subjects), scope: pick(scopes), facet: pick(facets), effect: pick(["allow", "allow", "deny"] as const), actions: [...new Set([pick(ACTIONS), pick(ACTIONS)])] });
  for (const selected of [[], ["user:1"], ["group:measure"], ["user:1", "group:measure"]]) {
    const compiled = compilePolicy(generated, selected);
    for (const scope of [...scopes, "project:absent"]) for (const facet of facets) for (const action of ACTIONS) {
      const matching = generated.rules.filter(rule => selected.includes(rule.subject) && rule.scope === scope && rule.facet === facet && rule.actions.includes(action));
      const expected = matching.some(rule => rule.effect === "allow") && !matching.some(rule => rule.effect === "deny");
      expect(compiled.allows(scope, facet, action)).toBe(expected);
      expect(allows(generated, { tenant: "test", version: "9", subjects: selected, scope, facet, action })).toBe(expected);
      expect(compiled.areas.find(area => area.scope === scope && area.facet === facet)?.actions.includes(action) ?? false).toBe(expected);
    }
  }
});

test("compiled grants remain immutable and do not infer reads from writes", () => {
  const source = policy(rules);
  source.rules.push({ subject: "user:1", scope: "project:write-only", facet: "scope", effect: "allow", actions: ["update"] });
  const compiled = compilePolicy(source, request.subjects);
  expect(compiled.allows("project:write-only", "scope", "update")).toBe(true);
  expect(compiled.allows("project:write-only", "scope", "read")).toBe(false);
  expect(compiled.allows({ toString: () => "project:write-only" } as unknown as string, "scope", "update")).toBe(false);
  expect(compiled.allows("project:write-only", { toString: () => "scope" } as unknown as "scope", "update")).toBe(false);
  expect(compiled.allows("project:write-only", "scope", { toString: () => "update" } as unknown as "update")).toBe(false);
  expect(compiled.allows("project:write-only", "scope", "constructor" as "update")).toBe(false);
  source.rules[0]!.actions.push("update");
  expect(compiled.allows("project:123", "scope", "update")).toBe(false);
  expect(() => Array.prototype.push.call(compiled.areas[0]!.actions, "delete")).toThrow();
  expect(() => Object.assign(compiled.areas[0]!, { scope: "project:other" })).toThrow();
});

test("a signed account suspension vetoes root and inherited grants without removing individual rules", () => {
  const source = { tenant: "test", version: "1", rules: [{ subject: "user:1", scope: "project:4", facet: "master-data" as const, effect: "allow" as const, actions: [...ACTIONS] }], suspended: ["user:1"] };
  const blocked = compilePolicy(source, ["user:1"]);
  for (const action of ACTIONS) expect(blocked.allows("project:4", "master-data", action)).toBe(false);
  expect(blocked.areas[0]!.actions).toEqual([]);
  expect(compilePolicy({ ...source, suspended: [] }, ["user:1"]).allows("project:4", "master-data", "read")).toBe(true);
  expect(source.rules).toHaveLength(1);
  for (const suspended of [["user:0"], ["user:01"], ["user:1", "user:1"], ["user:2", "user:1"], ["group:all"]]) expect(() => policy({ ...source, suspended })).toThrow();
});

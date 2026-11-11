import { expect, test } from "bun:test";
import { allows, policy } from "../src";
import type { Policy } from "../src";

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

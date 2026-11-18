import { expect, test } from "bun:test";
import { reconcilePolicyRules, type Rule } from "../src/index";

type Provenance = "automatic";
const managed = (rule: Rule<string, Provenance>) => rule.origin === "automatic";
const grant: Rule<string, Provenance> = {
  subject: "member:alice",
  scope: "project:42",
  facet: "schedule",
  actions: ["read", "update"],
  effect: "allow",
  origin: "automatic",
};
const manual: Rule<string, Provenance> = {
  subject: "member:bob",
  scope: "project:17",
  facet: "pricing",
  actions: ["read"],
  effect: "deny",
};

test("matching derived rules keep their source field and array order among independent policies", () => {
  const stored: Rule<string, Provenance> = {
    actions: ["update", "read"],
    scope: grant.scope,
    subject: grant.subject,
    effect: grant.effect,
    facet: grant.facet,
    origin: "automatic",
  };
  const current = [stored, manual];
  const next = reconcilePolicyRules(current, [grant], managed);
  expect(JSON.stringify(next)).toBe(JSON.stringify(current));
  expect(next[0]).not.toBe(stored);
  next[0]!.actions.push("delete");
  expect(stored.actions).toEqual(["update", "read"]);
});

test("obsolete and duplicate owned rules are removed while new rules append and manual denials stay", () => {
  const obsolete = { ...grant, subject: "member:former" };
  const extra = { ...grant, subject: "member:carol" };
  expect(
    reconcilePolicyRules(
      [obsolete, grant, manual, grant],
      [grant, extra],
      managed,
    ),
  ).toEqual([grant, manual, extra]);
  expect(reconcilePolicyRules([grant, manual], [], managed)).toEqual([manual]);
  expect(() => reconcilePolicyRules([], [manual], managed)).toThrow();
  expect(() => reconcilePolicyRules([], [grant, grant], managed)).toThrow();
});

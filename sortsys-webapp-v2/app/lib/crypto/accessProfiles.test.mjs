import { expect, test } from "bun:test";
import { ACTIONS, compilePolicy } from "@sortsys/zerotrust/sortsys";
import {
  accessActions,
  accessChanged,
  accessDraft,
  accessPreset,
  accessValue,
  actionPatch,
  compileManagedAccess,
  DATA_ACTIONS,
  editAccessDraft,
  hasAccess,
  managedAccess,
  patchAccessRules,
  profilePatch,
  sameAccess,
  withActions,
} from "./accessProfiles";
const area = { scope: "personnel:4", facet: "calculation" };
const rule = (actions, effect = "allow", subject = "user:2") => ({
  ...area,
  actions,
  effect,
  subject,
});
const permissions = (rules, extra = {}) => ({
  tenant: "test",
  version: "3",
  rules,
  ...extra,
});

test("managed profiles retain exact actions, denials, missing reads and suspension semantics", () => {
  const all = [...DATA_ACTIONS];
  expect(compileManagedAccess(permissions([rule(all)]), "user:2")(area)).toBe(
    "write",
  );
  expect(
    compileManagedAccess(
      permissions([rule(all), rule(["delete"], "deny")]),
      "user:2",
    )(area),
  ).toEqual({ actions: ["read", "create", "update"] });
  const latent = compileManagedAccess(
    permissions([rule(all), rule(["read"], "deny")]),
    "user:2",
  )(area);
  expect(accessPreset(latent)).toBe("custom");
  expect(hasAccess(latent, "read")).toBe(false);
  expect(hasAccess(latent, "delete")).toBe(true);
  expect(
    compileManagedAccess(permissions([rule(["update"])]), "user:2")(area),
  ).toEqual({ actions: ["update"] });
  expect(
    compileManagedAccess(
      permissions([rule(all)], { suspended: ["user:2"] }),
      "user:2",
    )(area),
  ).toBe("none");
  expect(compileManagedAccess(permissions([rule(all)]), "user:3")(area)).toBe(
    "none",
  );
});
test("managed snapshots do not normalize or later follow custom rules", () => {
  const input = permissions([rule(["read", "update"])]),
    saved = structuredClone(input),
    value = compileManagedAccess(input, "user:2");
  expect(value(area)).toEqual({ actions: ["read", "update"] });
  expect(input).toEqual(saved);
  input.rules[0].actions.push("create", "delete");
  expect(value(area)).toEqual({ actions: ["read", "update"] });
  expect(value({ ...area, facet: "scope" })).toBe("none");
});
test("profiles normalize action order while rejecting unknown fields, actions and duplicate entries", () => {
  expect(accessValue({ actions: ["delete", "read"] })).toEqual({
    actions: ["read", "delete"],
  });
  expect(accessValue({ actions: ["read"] })).toBe("read");
  expect(accessValue({ actions: [] })).toBe("none");
  expect(
    sameAccess("write", { actions: ["delete", "create", "read", "update"] }),
  ).toBe(true);
  for (const bad of [
    "constructor",
    "custom",
    null,
    { actions: ["read", "read"] },
    { actions: ["unknown"] },
    { actions: ["read"], extra: true },
  ])
    expect(() => accessValue(bad)).toThrow();
  for (const bad of [{ unknown: true }, { read: "yes" }, [], null])
    expect(() => actionPatch(bad)).toThrow();
  expect(
    managedAccess({
      catalogue: { actions: ["delete", "read"] },
      customers: "none",
      contacts: "read",
      vendors: "none",
      prices: "write",
      assistant: false,
    }).catalogue,
  ).toEqual({ actions: ["read", "delete"] });
});
test("an individual action patch preserves other decisions and unrelated extended grants", () => {
  const rules = [
    rule(["read", "update", "delete", "approve", "grant"]),
    rule(["delete"], "deny"),
    rule(["create"], "allow", "user:3"),
    { ...rule(["read"], "deny"), scope: "personnel:5" },
  ];
  const before = structuredClone(rules),
    next = patchAccessRules(rules, "user:2", [
      { area, patch: { delete: true } },
    ]);
  const access = compilePolicy(permissions(next), ["user:2"]);
  expect(access.allows(area.scope, area.facet, "delete")).toBe(true);
  expect(access.allows(area.scope, area.facet, "create")).toBe(false);
  expect(access.allows(area.scope, area.facet, "update")).toBe(true);
  expect(access.allows(area.scope, area.facet, "approve")).toBe(true);
  expect(access.allows(area.scope, area.facet, "grant")).toBe(true);
  expect(next.slice(0, 3)).toEqual([
    rule(["read", "update", "approve", "grant"]),
    before[2],
    before[3],
  ]);
  expect(rules).toEqual(before);
  expect(
    patchAccessRules(next, "user:2", [{ area, patch: { delete: true } }]),
  ).toEqual(next);
  expect(() =>
    patchAccessRules(rules, "user:2", [
      { area, patch: {} },
      { area, patch: {} },
    ]),
  ).toThrow();
});
test("drafts distinguish individual edits from explicit full presets and preserve extended actions", () => {
  const original = { actions: ["read", "update", "grant"] },
    first = accessDraft(original);
  const individual = editAccessDraft(
    first,
    withActions(first.value, { delete: true }),
    ["delete"],
  );
  expect(individual.patch).toEqual({ delete: true });
  expect(accessChanged(individual)).toBe(true);
  const cancelled = editAccessDraft(
    individual,
    withActions(individual.value, { delete: false }),
    ["delete"],
  );
  expect(accessChanged(cancelled)).toBe(false);
  expect(accessActions(cancelled.value)).toEqual(original.actions);
  const removed = editAccessDraft(
    first,
    withActions(first.value, profilePatch("none")),
    ACTIONS,
  );
  expect(removed.patch).toEqual({
    read: false,
    create: false,
    update: false,
    delete: false,
    approve: false,
    grant: false,
  });
  expect(hasAccess(removed.value, "grant")).toBe(false);
});
test("saving one changed action can rebase onto newer unrelated actions without overwriting them", () => {
  const draft = editAccessDraft(
    accessDraft("read"),
    { actions: ["read", "delete"] },
    ["delete"],
  );
  const newer = [rule(["read", "update"]), rule(["create"], "deny")];
  const result = patchAccessRules(newer, "user:2", [
    { area, patch: draft.patch },
  ]);
  expect(result.slice(0, 2)).toEqual(newer);
  expect(compileManagedAccess(permissions(result), "user:2")(area)).toEqual({
    actions: ["read", "update", "delete"],
  });
});

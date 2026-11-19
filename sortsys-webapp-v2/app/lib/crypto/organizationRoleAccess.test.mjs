import { expect, test } from "bun:test";
import { compilePolicy } from "@sortsys/zerotrust/sortsys";
import {
  editOrganizationRoles,
  memberOrganizationRoles,
  parseOrganizationRolePatch,
} from "./organizationRoleAccess";

test("removing one business role preserves independent permissions and explicit denials", () => {
  const subject = "user:2";
  const direct = { subject, facet: "master-data" };
  const manual = [
    {
      ...direct,
      scope: "catalog:products",
      actions: ["update"],
      effect: "allow",
    },
    { ...direct, scope: "catalog:contacts", actions: ["read"], effect: "deny" },
  ];
  const enabled = editOrganizationRoles(manual, subject, {
    "organization-office": true,
    "organization-procurement": true,
  });
  const purchaseRemoved = editOrganizationRoles(enabled.rules, subject, {
    "organization-procurement": false,
  });
  expect(memberOrganizationRoles(purchaseRemoved.rules, subject)).toEqual({
    "organization-office": true,
    "organization-procurement": false,
  });
  expect(purchaseRemoved.rules.filter((rule) => !rule.origin)).toEqual(manual);
  const access = compilePolicy(
    {
      tenant: "test",
      version: "1",
      rules: purchaseRemoved.rules,
    },
    [subject],
  );
  expect(access.allows("catalog:products", "master-data", "read")).toBe(true);
  expect(access.allows("catalog:products", "master-data", "update")).toBe(true);
  expect(access.allows("catalog:products", "procurement", "read")).toBe(false);
  expect(access.allows("catalog:contacts", "master-data", "read")).toBe(false);
});

test("role patches accept only supported incremental boolean decisions", () => {
  expect(parseOrganizationRolePatch({ "organization-office": false })).toEqual({
    "organization-office": false,
  });
  expect(() => parseOrganizationRolePatch({ ":admin": true })).toThrow();
  expect(() =>
    parseOrganizationRolePatch({ "organization-procurement": "yes" }),
  ).toThrow();
  expect(() => parseOrganizationRolePatch([])).toThrow();
});

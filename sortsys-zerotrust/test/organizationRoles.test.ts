import { expect, test } from "bun:test";
import {
  administrativeProfiles,
  certifyIdentity,
  compilePolicy,
  createIdentity,
  organizationRoleRules,
  policy,
  projectRoleRules,
  publicIdentity,
  signAdministrativePolicy,
  signPolicy,
  verifyPolicy,
  type Rule,
} from "../src/sortsys";

const member = "user:2";
const office = organizationRoleRules("organization-office", member);

test("the signed role vocabulary requires every prescribed area and exact actions", () => {
  const validate = (rules: Rule[]) =>
    policy({ tenant: "test", version: "1", rules });
  expect(validate(office).rules).toEqual(office);
  const purchasing = organizationRoleRules("organization-procurement", member);
  expect(validate([...office, ...purchasing]).rules).toHaveLength(6);
  expect(() => validate(office.slice(1))).toThrow();
  expect(() => validate([...office, office[0]!])).toThrow();
  expect(() =>
    validate([
      { ...office[0]!, actions: ["read", "grant"] },
      ...office.slice(1),
    ]),
  ).toThrow();
  expect(() =>
    validate([{ ...office[0]!, scope: "project:4" }, ...office.slice(1)]),
  ).toThrow();
});

test("project role assignments bind every required area to one project", () => {
  const rules = projectRoleRules("project-documentation", member, "3");
  const overview = projectRoleRules("project-overview", member, "5");
  const validate = (entries: Rule[]) =>
    policy({ tenant: "test", version: "1", rules: entries });

  expect(validate([...rules, ...overview]).rules).toHaveLength(6);
  expect(() => validate(rules.slice(1))).toThrow();
  expect(() =>
    validate([...rules, ...projectRoleRules("project-overview", member, "3")]),
  ).toThrow();
  expect(() =>
    validate(rules.map((rule, index) =>
      index === 2 ? { ...rule, scope: "project:5:daily-reports" } : rule,
    )),
  ).toThrow();
  expect(() =>
    validate(rules.map((rule, index) =>
      index === 2 ? { ...rule, facet: "calculation" } : rule,
    )),
  ).toThrow();
  expect(() =>
    projectRoleRules("project-overview", member, "3:planning"),
  ).toThrow();
});

test("a delegated denial overrides the role while preserving its signed provenance", async () => {
  const authority = await createIdentity();
  const manager = await createIdentity();
  const author = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:3",
      ...(await publicIdentity(manager)),
    },
    authority.signingKey.privateKey,
  );
  const rootPermissions = policy({
    tenant: "test",
    version: "1",
    rules: [
      ...office,
      {
        subject: author.user,
        scope: "catalog:customers",
        facet: "master-data",
        effect: "allow",
        actions: ["read", "grant"],
      },
    ],
  });
  const root = await signPolicy(
    rootPermissions,
    authority.signingKey.privateKey,
  );
  const profile = await administrativeProfiles.sign(
    {
      tenant: root.tenant,
      rootSignature: root.signature,
      version: "2",
      subject: member,
      scope: "catalog:customers",
      facet: "master-data",
      actions: [],
      author,
    },
    manager.signingKey.privateKey,
  );
  const delegated = await signAdministrativePolicy(
    {
      root,
      profiles: [profile],
      previousSignature: root.signature,
      version: "2",
      author,
    },
    manager.signingKey.privateKey,
  );
  const checked = await verifyPolicy(delegated, {
    tenant: root.tenant,
    authority: authority.signingKey.publicKey,
  });
  expect(checked.permissions.rules.filter((rule) => rule.origin)).toEqual(
    office,
  );
  const access = compilePolicy(checked.permissions, [member]);
  expect(access.allows("catalog:customers", "master-data", "read")).toBe(false);
  expect(access.allows("catalog:contacts", "master-data", "update")).toBe(true);
});

import { afterEach, expect, test } from "bun:test";
import {
  administrativeProfiles,
  signAdministrativePolicy,
} from "@sortsys/zerotrust/sortsys";
import { PRODUCT_COLLECTION, PRICE_COLLECTION } from "../data/products";
import { managedArea, hasScopedManagement } from "./managedAreas";
import {
  projectManagedPermissions,
  readScopedManagement,
} from "./scopedManagement";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { lockCryptoSession } from "./session";

afterEach(() => lockCryptoSession());

const manager = "user:2";
const member = "user:3";
const catalogue = managedArea(PRODUCT_COLLECTION.domain);
const prices = managedArea(PRICE_COLLECTION.domain);

function rule(subject, area, actions, effect = "allow") {
  return { subject, scope: area.scope, facet: area.facet, actions, effect };
}
function policy(...rules) {
  return { tenant: "test", version: "1", rules };
}

test("reloading a real delegated policy uses its verified primary permissions rather than treating a signed packet as a plain policy", async () => {
  const fixture = await protectedTenant([PRODUCT_COLLECTION]);
  const [root] = await fixture.client.query("zerotrust.policy.get");
  const version = (BigInt(root.version) + 1n).toString();
  const profile = await administrativeProfiles.sign(
    {
      tenant: "test",
      rootSignature: root.signature,
      version,
      subject: "user:2",
      scope: PRODUCT_COLLECTION.scope,
      facet: PRODUCT_COLLECTION.facet,
      actions: ["read"],
      author: fixture.setup.owner,
    },
    fixture.identity.signingKey.privateKey,
  );
  const signed = await signAdministrativePolicy(
    {
      root,
      profiles: [profile],
      author: fixture.setup.owner,
      previousSignature: root.signature,
      version,
    },
    fixture.identity.signingKey.privateKey,
  );
  const query = fixture.client.query.bind(fixture.client);
  fixture.client.query = async (path, input) => {
    if (path === "zerotrust.policy.get") return [signed, null];
    if (path === "zerotrust.identities.recipients")
      return [{ rows: [], after: null }, null];
    if (path === "users.list") return [[], null];
    return query(path, input);
  };
  const workspace = await readScopedManagement(
    fixture.client,
    new AbortController().signal,
  );
  expect(workspace.areas.map(({ area }) => area.domain)).toEqual([
    PRODUCT_COLLECTION.domain,
  ]);
  expect(workspace.members).toEqual([]);
});

test("only readable business management areas open the administration entrypoint", () => {
  for (const actions of [["read"], ["grant"], ["read", "update"]]) {
    expect(
      hasScopedManagement(
        policy(rule(manager, PRODUCT_COLLECTION, actions)),
        manager,
      ),
    ).toBe(false);
  }
  const allowed = policy(
    rule(manager, PRODUCT_COLLECTION, ["read", "update", "grant"]),
  );
  expect(hasScopedManagement(allowed, manager)).toBe(true);
  expect(hasScopedManagement(allowed, member)).toBe(false);
  expect(
    hasScopedManagement({ ...allowed, suspended: [manager] }, manager),
  ).toBe(false);
  expect(
    hasScopedManagement(
      policy(
        ...allowed.rules,
        rule(manager, PRODUCT_COLLECTION, ["grant"], "deny"),
      ),
      manager,
    ),
  ).toBe(false);
  expect(
    hasScopedManagement(
      policy({
        subject: manager,
        scope: "preferences:user:2",
        facet: "master-data",
        actions: ["read", "grant"],
        effect: "allow",
      }),
      manager,
    ),
  ).toBe(false);
});

test("a manager sees only delegated areas and can offer only owned ordinary actions", () => {
  const checkpoint = policy(
    rule(manager, PRODUCT_COLLECTION, ["read", "update", "grant"]),
    rule(member, PRODUCT_COLLECTION, ["read"]),
  );
  const selected = projectManagedPermissions(
    checkpoint,
    checkpoint,
    manager,
    member,
    [catalogue, prices],
  );
  expect(selected).toHaveLength(1);
  expect(selected[0].area).toEqual(PRODUCT_COLLECTION);
  expect(selected[0].actions).toEqual(["read", "update"]);
  expect(selected[0].editable).toBe(true);
  expect(selected[0].value).toBe("read");
});

test("recipient management and stronger rights remain locked, while unrelated private grants do not interfere", () => {
  const checkpoint = policy(
    rule(manager, PRODUCT_COLLECTION, ["read", "update", "grant"]),
    rule(member, PRODUCT_COLLECTION, ["read"]),
    {
      subject: member,
      scope: "preferences:user:3",
      facet: "master-data",
      actions: ["read", "grant"],
      effect: "allow",
    },
  );
  const project = (current, root = checkpoint, recipient = member) =>
    projectManagedPermissions(current, root, manager, recipient, [
      catalogue,
    ])[0];
  expect(project(checkpoint).editable).toBe(true);
  const peerManager = policy(
    ...checkpoint.rules,
    rule(member, PRODUCT_COLLECTION, ["grant"]),
  );
  expect(project(peerManager, peerManager).editable).toBe(false);
  const stronger = policy(
    ...checkpoint.rules,
    rule(member, PRODUCT_COLLECTION, ["delete"]),
  );
  expect(project(stronger).editable).toBe(false);
  expect(project(checkpoint, checkpoint, manager).editable).toBe(false);
});

test("current denials and missing checkpoint grants hide controls even when inherited rules grant management", () => {
  const checkpoint = policy(
    rule(manager, PRODUCT_COLLECTION, ["read", "update", "grant"]),
  );
  const revoked = policy(
    ...checkpoint.rules,
    rule(manager, PRODUCT_COLLECTION, ["grant"], "deny"),
  );
  expect(
    projectManagedPermissions(revoked, checkpoint, manager, member, [
      catalogue,
    ]),
  ).toEqual([]);
  expect(
    projectManagedPermissions(checkpoint, policy(), manager, member, [
      catalogue,
    ]),
  ).toEqual([]);
  const suspended = { ...checkpoint, suspended: [manager] };
  expect(
    projectManagedPermissions(suspended, checkpoint, manager, member, [
      catalogue,
    ]),
  ).toEqual([]);
});

test("business domain recognition preserves independent modules and excludes private and creation scopes", () => {
  for (const domain of [
    "project:a:daily-reports:calculation",
    "commercial:b:measurement",
    "personnel:c:scope",
    "absence:c:personnel",
    "tool:d:procurement",
    "tool-tracking:e:scope",
    "organization:invoicing:billing",
  ]) {
    const descriptor = managedArea(domain);
    expect(descriptor.area.domain).toBe(domain);
    expect(`${descriptor.area.scope}:${descriptor.area.facet}`).toBe(domain);
  }
  for (const domain of [
    "project:a:personnel",
    "creation:project:master-data",
    "preferences:user:2:master-data",
    "assistant:user:2:master-data",
    "project:a:daily-reports:billing",
    "unknown:master-data",
  ]) {
    expect(managedArea(domain)).toBeNull();
  }
});

import { afterEach, expect, test } from "bun:test";
import { ACTIONS, base64, createAccountVault, createIdentity, createTenantSetup, policy, signPolicy } from "@sortsys/zerotrust";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { createContentAccess, projectMenuAccess, protectedMenuRole, readMenuAccess } from "./menuAccess";

afterEach(() => lockCryptoSession());
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const rule = (scope, facet, actions, effect = "allow", subject = "user:1") => ({ subject, scope, facet, actions, effect });
const project = rules => projectMenuAccess(policy({ tenant: "test", version: "1", rules }), "user:1");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("content navigation uses explicit grants, independent prices and dominant denials", () => {
  const view = project([rule("catalog:products", "master-data", ["read"]), rule("catalog:products", "procurement", [...ACTIONS]),
    rule("catalog:vendors", "master-data", [...ACTIONS], "allow", "user:2"), rule("catalog:products", "procurement", ["update"], "deny")]);
  expect(view.role("view:products")).toBe(true); expect(view.role("manage:products")).toBe(false);
  expect(view.role("view:productPriceRecords")).toBe(true); expect(view.role("manage:productPriceRecords")).toBe(false);
  expect(view.role("view:productVendors")).toBe(false); expect(view.role(":admin")).toBeUndefined();
  expect(view.role(":llm")).toBeUndefined(); expect(protectedMenuRole("manage:users")).toBe(false);
  expect(project([rule("catalog:contacts", "master-data", ["update"])]).role("manage:contacts")).toBe(false);
});

test("offer creation and project creation are independent from existing project writes", () => {
  const offers = project([rule("create:commercial", "master-data", ["create"])]);
  expect(offers.canCreate("commercial")).toBe(true); expect(offers.canCreate("project")).toBe(false);
  expect(offers.canSeeOffers()).toBe(true); expect(offers.role("view:projects")).toBe(false);
  const projects = project([rule("project:4", "master-data", [...ACTIONS]), rule("project:5", "master-data", ["read"])]);
  expect(projects.role("manage:projects")).toBe(true); expect(projects.canCreate("commercial")).toBe(false);
  expect(projects.can("project:5", "master-data", "update")).toBe(false);
  expect(projects.canAny("project", "attachment", "read")).toBe(false);
  expect(project([rule("commercial:8", "master-data", ["read"])]).canSeeOffers()).toBe(true);
});

test("delivery-note navigation needs explicit project quantities and does not grant procurement", () => {
  const notes = project([rule("project:4", "contract-quantities", ["read", "update"])]);
  expect(notes.role("view:deliveryNotes")).toBe(true); expect(notes.role("manage:deliveryNotes")).toBe(true);
  expect(notes.role("delete:deliveryNotes")).toBe(false); expect(notes.canCreate("delivery-note")).toBe(false);
  expect(notes.can("project:4", "procurement", "read")).toBe(false);
  expect(project([rule("project:4", "master-data", [...ACTIONS])]).role("view:deliveryNotes")).toBe(false);
  expect(project([rule("project:4", "contract-quantities", ["read", "create"])]).canCreate("delivery-note")).toBe(true);
  expect(project([rule("project:4", "contract-quantities", [...ACTIONS]), rule("project:4", "contract-quantities", ["read"], "deny")]).role("manage:deliveryNotes")).toBe(false);
});

test("tool menus distinguish individual masters, costs, inventories and tracking records", () => {
  const tool = project([rule("tool:4", "master-data", ["read"])]);
  expect(tool.role("view:tools")).toBe(true); expect(tool.role("manage:tools")).toBe(false);
  expect(tool.role("view:toolInventories")).toBe(false); expect(tool.role("view:toolTrackings")).toBe(false);
  expect(tool.can("tool:4", "procurement", "read")).toBe(false);
  const own = project([rule("tool-tracking:5", "master-data", ["read"]), rule("tool-tracking:5", "scope", ["read", "create", "update"])]);
  expect(own.role("view:toolTrackings")).toBe(true); expect(own.role("manage:toolTrackings")).toBe(false);
  expect(own.can("tool-tracking:6", "master-data", "read")).toBe(false);
  expect(project([rule("tool:4", "measurement", ["read", "update"])]).role("manage:toolInventories")).toBe(true);
  const index = project([rule("catalog:tools", "master-data", [...ACTIONS])]);
  expect(index.canCreate("tool")).toBe(true); expect(index.role("view:tools")).toBe(false);
});

async function fixture() {
  const identity = await createIdentity(), { setup, authorityKey } = await createTenantSetup("test", "user:1", identity, PHRASE, { scopes: [] });
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(exportKey, await createAccountVault(exportKey, "test", "owner", identity, { recoveryGeneration: "1", recoverySigningKey: setup.authority.recoverySigningKey }), false);
  let permissions = await signPolicy({ tenant: "test", version: "1", rules: [rule("catalog:vendors", "master-data", ["read"])] }, authorityKey.privateKey);
  const sent = [], client = { loggedIn: () => true, async query(path) {
    sent.push(path);
    if (path === "auth.sessionInfo") return [{ user: { id: "1", username: "owner" }, roles: [":admin"] }, null];
    if (path === "zerotrust.trust.history") return [{ authorities: [{ certificate: setup.authority, transition: null }], identities: [setup.owner] }, null];
    if (path === "zerotrust.policy.get") return [permissions, null];
    if (path === "zerotrust.creations.list") return [[], null];
    throw new Error("Unexpected menu RPC " + path);
  } };
  return { client, sent, get: () => permissions, set: value => { permissions = value; }, sign: rules => signPolicy({ tenant: "test", version: "2", rules }, authorityKey.privateKey) };
}

test("menu access verifies signed policy and never requests content keys or business records", async () => {
  const data = await fixture(), signal = new AbortController().signal;
  expect((await readMenuAccess(data.client, signal)).role("manage:productVendors")).toBe(false);
  data.set({ ...data.get(), rules: [rule("catalog:vendors", "master-data", [...ACTIONS])] });
  await expect(readMenuAccess(data.client, signal)).rejects.toThrow();
  expect(data.sent.every(path => ["auth.sessionInfo", "zerotrust.trust.history", "zerotrust.policy.get", "zerotrust.creations.list"].includes(path))).toBe(true);
});

test("an invalidated asynchronous policy result cannot restore old menu rights", async () => {
  const data = await fixture(), context = new AbortController(), service = createContentAccess(data.client, () => context.signal);
  const release = deferred(), entered = deferred(), original = data.client.query;
  let held = true;
  data.client.query = async path => { const result = await original(path); if (path === "zerotrust.policy.get" && held) { held = false; entered.resolve(); await release.promise; } return result; };
  try {
    const stale = service.read().then(() => false, () => true); await entered.promise;
    data.set(await data.sign([rule("catalog:products", "procurement", ["read"])])); service.refresh();
    expect((await service.read()).role("view:productPriceRecords")).toBe(true);
    release.resolve(); expect(await stale).toBe(true);
    expect((await service.read()).role("view:productVendors")).toBe(false);
  } finally { release.resolve(); service.close(); }
});

test("a substituted session identifier cannot select a different identity's signed grants", async () => {
  const data = await fixture(), original = data.client.query;
  data.client.query = path => path === "auth.sessionInfo" ? Promise.resolve([{ user: { id: "2", username: "owner" }, roles: [":admin"] }, null]) : original(path);
  await expect(readMenuAccess(data.client, new AbortController().signal)).rejects.toThrow();
});

test("cached projections cannot cross account replacement even before an explicit refresh", async () => {
  const data = await fixture(), context = new AbortController(), service = createContentAccess(data.client, () => context.signal);
  try {
    expect((await service.read()).role("view:productVendors")).toBe(true);
    const other = await createIdentity(), exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(exportKey, await createAccountVault(exportKey, "test", "different", other, {}), false);
    expect(await service.read()).toBe(null);
  } finally { service.close(); }
});

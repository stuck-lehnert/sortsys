import { afterEach, expect, test } from "bun:test";
import {
  ACTIONS,
  base64,
  certifyIdentity,
  compilePolicy,
  createAccountVault,
  createIdentity,
  createTenantSetup,
  publicIdentity,
  signPolicy,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "./session";
import {
  changeAreaActionAccesses,
  changeMemberAccess,
  memberAreaAccesses,
} from "./permissions";
import { MASTER_DATA_AREAS, profilePatch } from "./accessProfiles";
import { projectAccessArea } from "../data/projectScope";
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
afterEach(() => lockCryptoSession());
async function fixture() {
  const owner = await createIdentity(),
    member = await createIdentity(),
    a = MASTER_DATA_AREAS.catalogue,
    b = projectAccessArea("4", "regie-reports:master-data");
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    "user:1",
    owner,
    PHRASE,
    { scopes: [a, b] },
  );
  const certificate = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:2",
      ...(await publicIdentity(member)),
    },
    authorityKey.privateKey,
  );
  const { signature, ...initial } = setup.policy;
  let permissions = await signPolicy(
    {
      ...initial,
      version: "2",
      rules: [
        ...setup.policy.rules,
        {
          subject: "user:2",
          scope: a.scope,
          facet: a.facet,
          effect: "allow",
          actions: ["read", "update", "approve"],
        },
        {
          subject: "user:2",
          scope: a.scope,
          facet: a.facet,
          effect: "deny",
          actions: ["delete"],
        },
        {
          subject: "user:2",
          scope: b.scope,
          facet: b.facet,
          effect: "allow",
          actions: ["read", "create"],
        },
      ],
    },
    authorityKey.privateKey,
  );
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(
    exportKey,
    await createAccountVault(exportKey, "test", "owner", owner, {
      recoveryGeneration: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    }),
    false,
  );
  const calls = [],
    saved = [],
    state = { mode: "normal" };
  const client = {
    loggedIn: () => true,
    async invalidate() {},
    async query(path) {
      calls.push(path);
      if (path === "auth.sessionInfo")
        return [
          { user: { id: "1", username: "owner" }, roles: [":admin"] },
          null,
        ];
      if (path === "zerotrust.trust.history")
        return [
          {
            authorities: [{ certificate: setup.authority, transition: null }],
            identities: [setup.owner, certificate],
          },
          null,
        ];
      if (path === "zerotrust.policy.get") return [permissions, null];
      if (path === "zerotrust.status") return [{ profile: setup }, null];
      if (path === "zerotrust.creations.list") return [[], null];
      if (path === "zerotrust.identities.list")
        return [
          [setup.owner, certificate].map((cert) => ({
            subject: cert.user,
            ...cert,
            certificate: cert,
          })),
          null,
        ];
      if (path === "zerotrust.domains.list")
        return [
          [a, b].map((area) => ({
            id: area.domain,
            scope: area.scope,
            facet: area.facet,
            generation: "1",
            rotationRequired: false,
          })),
          null,
        ];
      throw new Error("Unexpected query: " + path);
    },
    async mutate(path, input) {
      calls.push(path);
      if (path !== "zerotrust.policy.replace")
        throw new Error("Unexpected mutation: " + path);
      await verifyPolicy(input, {
        tenant: "test",
        authority: authorityKey.publicKey,
      });
      saved.push(input);
      if (state.mode === "false") return [{ success: true }, null];
      permissions = input;
      if (state.mode === "lost") throw new Error("Lost committed policy reply");
      return [{ success: true }, null];
    },
  };
  return { client, a, b, state, saved, calls, get: () => permissions };
}
test("multiple edited areas publish one signed policy and preserve unedited custom actions and denials", async () => {
  const f = await fixture(),
    before = f.get();
  await changeAreaActionAccesses(
    f.client,
    "user:2",
    [
      { area: f.a, patch: { delete: true } },
      { area: f.b, patch: { create: false } },
    ],
    new AbortController().signal,
  );
  expect(f.saved).toHaveLength(1);
  expect(f.get().version).toBe("3");
  const own = f.get().rules.filter((rule) => rule.subject === "user:2");
  expect(
    own.some(
      (rule) =>
        rule.scope === f.a.scope &&
        rule.effect === "allow" &&
        rule.actions.join() === "read,update,approve",
    ),
  ).toBe(true);
  expect(
    own.some(
      (rule) =>
        rule.scope === f.a.scope &&
        rule.effect === "allow" &&
        rule.actions.includes("delete"),
    ),
  ).toBe(true);
  expect(
    own.some(
      (rule) =>
        rule.scope === f.b.scope &&
        rule.effect === "deny" &&
        rule.actions.includes("create"),
    ),
  ).toBe(true);
  expect(f.get().rules.filter((rule) => rule.subject !== "user:2")).toEqual(
    before.rules.filter((rule) => rule.subject !== "user:2"),
  );
  expect(
    f.calls.some(
      (path) => path.includes("keys.") || path.startsWith("products."),
    ),
  ).toBe(false);
});
test("a false policy acknowledgement does not confirm action edits; an actually committed lost reply does", async () => {
  const f = await fixture(),
    previous = f.get().signature,
    changes = [{ area: f.a, patch: { delete: true } }];
  f.state.mode = "false";
  await expect(
    changeAreaActionAccesses(
      f.client,
      "user:2",
      changes,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.get().signature).toBe(previous);
  f.state.mode = "lost";
  await changeAreaActionAccesses(
    f.client,
    "user:2",
    changes,
    new AbortController().signal,
  );
  expect(f.get().signature).not.toBe(previous);
  const count = f.saved.length;
  await changeAreaActionAccesses(
    f.client,
    "user:2",
    changes,
    new AbortController().signal,
  );
  expect(f.saved).toHaveLength(count);
});
test("master-data form patches only explicitly edited actions and leaves another area's current profile intact", async () => {
  const f = await fixture(),
    before = f.get().rules;
  await changeMemberAccess(
    f.client,
    "user:2",
    {
      catalogue: { actions: ["read", "delete"] },
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    new AbortController().signal,
    { actions: { catalogue: { delete: true } } },
  );
  expect(
    f
      .get()
      .rules.some(
        (rule) =>
          rule.subject === "user:2" &&
          rule.scope === f.a.scope &&
          rule.actions.join() === "read,update,approve",
      ),
  ).toBe(true);
  expect(f.get().rules.filter((rule) => rule.scope === f.b.scope)).toEqual(
    before.filter((rule) => rule.scope === f.b.scope),
  );
});
test("the read preset also removes existing approval rights without changing another area's profile", async () => {
  const f = await fixture(),
    previous = f.get().rules.filter((rule) => rule.scope === f.b.scope);
  await changeAreaActionAccesses(
    f.client,
    "user:2",
    [{ area: f.a, patch: profilePatch("read") }],
    new AbortController().signal,
  );
  const { signature, ...permissions } = f.get(),
    access = compilePolicy(permissions, ["user:2"]);
  expect(
    ACTIONS.filter((action) => access.allows(f.a.scope, f.a.facet, action)),
  ).toEqual(["read"]);
  expect(f.get().rules.filter((rule) => rule.scope === f.b.scope)).toEqual(
    previous,
  );
  expect(f.saved).toHaveLength(1);
});

test("fixed-area access reads effective custom actions and rejects an uncertified recipient", async () => {
  const f = await fixture();
  const levels = await memberAreaAccesses(
    f.client,
    "user:2",
    [f.a, f.b],
    new AbortController().signal,
  );
  expect(levels).toEqual([
    { actions: ["read", "update", "approve"] },
    { actions: ["read", "create"] },
  ]);
  await expect(
    memberAreaAccesses(f.client, "user:3", [f.a], new AbortController().signal),
  ).rejects.toThrow();
  expect(f.saved).toHaveLength(0);
});

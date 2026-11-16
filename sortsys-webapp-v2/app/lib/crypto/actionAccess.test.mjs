import { afterEach, expect, test } from "bun:test";
import {
  ACTIONS,
  base64,
  certifyIdentity,
  compilePolicy,
  createAccountVault,
  createIdentity,
  createDomain,
  createTenantSetup,
  openBox,
  publicIdentity,
  signPolicy,
  verifyPolicy,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "./session";
import {
  changeAreaActionAccesses,
  changeMemberAccess,
  memberAreaAccesses,
  finishAccessChanges,
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
  return {
    client,
    a,
    b,
    state,
    saved,
    calls,
    get: () => permissions,
    setPolicy: (value) => {
      permissions = value;
    },
    owner,
    member,
    setup,
    authorityKey,
  };
}

async function rotationFixture(conflict = false) {
  const f = await fixture();
  const areas = [f.a, f.b];
  const definitions = new Map();
  const pending = new Set(areas.map((area) => area.domain));
  const grants = [];
  for (const area of areas) {
    const { definition } = await createDomain({
      tenant: "test",
      id: area.domain,
      scope: area.scope,
      facet: area.facet,
      generation: "1",
      policyVersion: "1",
      authorityGeneration: "1",
      authorityKey: f.authorityKey.privateKey,
      recovery: {
        encryptionKey: f.setup.authority.recoveryEncryptionKey,
        signingKey: f.setup.authority.recoverySigningKey,
      },
      readers: [{ subject: "user:1", identity: await publicIdentity(f.owner) }],
    });
    definitions.set(`${area.domain}:1`, definition);
  }
  const query = f.client.query;
  f.client.query = async (path, input) => {
    if (path === "zerotrust.domains.list") {
      f.calls.push(path);
      return [
        areas.map((area) => ({
          id: area.domain,
          scope: area.scope,
          facet: area.facet,
          generation: pending.has(area.domain) ? "1" : "2",
          rotationRequired: pending.has(area.domain),
        })),
        null,
      ];
    }
    if (path === "zerotrust.domains.get" || path === "zerotrust.keys.get") {
      f.calls.push(path);
      const definition = definitions.get(`${input.domain}:${input.generation}`);
      expect(definition).toBeDefined();
      return [
        path === "zerotrust.keys.get"
          ? definition.envelopes.find((box) => box.recipient === "user:1")
          : definition,
        null,
      ];
    }
    if (path === "zerotrust.members.list") {
      f.calls.push(path);
      if (input.after === null)
        return [{ rows: [{ id: "1", enrolled: true }], after: "1" }, null];
      expect(input.after).toBe("1");
      return [{ rows: [{ id: "2", enrolled: true }], after: null }, null];
    }
    return query(path, input);
  };
  const mutate = f.client.mutate;
  f.client.mutate = async (path, input) => {
    if (path === "zerotrust.keys.grant") {
      f.calls.push(path);
      const original = definitions.get(`${input.domain}:${input.generation}`);
      const binding = {
        tenant: "test",
        purpose: "area-key",
        object: input.domain,
        generation: input.generation,
        author: "authority:1",
      };
      const before = await openBox(
        original.envelopes[0],
        { ...binding, recipient: "user:1" },
        f.owner.encryptionKey.privateKey,
        f.authorityKey.publicKey,
      );
      const shared = await openBox(
        input.envelope,
        { ...binding, recipient: "user:2" },
        f.member.encryptionKey.privateKey,
        f.authorityKey.publicKey,
      );
      try {
        expect(shared).toEqual(before);
      } finally {
        before.fill(0);
        shared.fill(0);
      }
      grants.push(input);
      return [{ success: true }, null];
    }
    if (path === "zerotrust.domains.put") {
      f.calls.push(path);
      if (conflict) {
        conflict = false;
        const { signature, ...previous } = f.get();
        f.setPolicy(
          await signPolicy(
            {
              ...previous,
              version: "3",
              rules: previous.rules.filter(
                (rule) => rule.subject !== "user:2" || rule.scope !== f.b.scope,
              ),
            },
            f.authorityKey.privateKey,
          ),
        );
        return [null, new Error("Concurrent policy change")];
      }
      expect(input.policyVersion).toBe(f.get().version);
      expect(input.generation).toBe("2");
      await verifyDomain(
        input,
        {
          tenant: "test",
          id: input.id,
          scope: input.scope,
          facet: input.facet,
          generation: "2",
        },
        () => f.authorityKey.publicKey,
      );
      definitions.set(`${input.id}:2`, input);
      pending.delete(input.id);
      return [{ success: true }, null];
    }
    return mutate(path, input);
  };
  return { ...f, definitions, grants };
}

for (const conflict of [false, true]) {
  test(`key changes reuse one member directory and revalidate a changed policy${conflict ? " after a concurrent revocation" : ""}`, async () => {
    const f = await rotationFixture(conflict);
    await finishAccessChanges(f.client, new AbortController().signal);
    const directoryReads = conflict ? 2 : 1;
    expect(
      f.calls.filter((path) => path === "zerotrust.identities.list"),
    ).toHaveLength(directoryReads);
    expect(
      f.calls.filter((path) => path === "zerotrust.members.list"),
    ).toHaveLength(directoryReads * 2);
    for (const area of [f.a, f.b]) {
      const updated = f.definitions.get(`${area.domain}:2`);
      expect(updated).toBeDefined();
      const recipients = updated.envelopes.map((box) => box.recipient);
      if (conflict && area === f.b) expect(recipients).toEqual(["user:1"]);
      else expect(recipients).toEqual(["user:1", "user:2"]);
    }
    expect(f.grants.length).toBeGreaterThan(0);
  });
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

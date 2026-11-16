import { afterEach, expect, test } from "bun:test";
import { RpcClientError } from "@sortsys/v2-client";
import { administratorPolicyContext } from "./administration";
import { verifiedAccessContext } from "./accessContext";
import {
  ACTIONS,
  base64,
  certifyIdentity,
  certifyCreationCapability,
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
  verifyCreationCapability,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "./session";
import {
  changeAreaActionAccesses,
  changeMemberAccess,
  memberAreaAccesses,
  finishAccessChanges,
  changeCreationAccesses,
  memberCreationAccesses,
} from "./permissions";
import { MASTER_DATA_AREAS, profilePatch } from "./accessProfiles";
import { projectAccessArea } from "../data/projectScope";
import { accessSnapshotFixture } from "../data/testing/accessSnapshot.mjs";
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
  const snapshots = [];
  const calls = [],
    saved = [],
    capabilities = new Map(),
    state = { mode: "normal" };
  const client = {
    loggedIn: () => true,
    async invalidate() {},
    async query(path, input) {
      calls.push(path);
      if (
        path === "zerotrust.access.snapshot" ||
        path === "zerotrust.access.page"
      ) {
        snapshots.push(structuredClone(input));
        return accessSnapshotFixture(client, input);
      }
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
      if (path === "zerotrust.creations.origin") return [null, null];
      if (path === "zerotrust.creations.capability") {
        return [capabilities.get(input.namespace) ?? null, null];
      }
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
      if (path === "zerotrust.creations.grant") {
        await verifyCreationCapability(input, authorityKey.publicKey);
        if (state.mode !== "false-capability")
          capabilities.set(input.namespace, input);
        if (state.duringGrant) {
          const work = state.duringGrant;
          state.duringGrant = null;
          await work();
        }
        if (state.mode === "lost-capability")
          throw new Error("Lost certificate acknowledgement");
        return [{ success: true }, null];
      }
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
    capabilities,
    snapshots,
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
  const publishedKeys = new Map();
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
    if (path === "zerotrust.keys.inspect") {
      f.calls.push(path);
      return [
        input.keys.map((key) =>
          publishedKeys.get(`${key.domain}:${key.generation}:${key.recipient}`),
        ),
        null,
      ];
    }
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
        return [
          { rows: [{ id: "1", enrolled: true, certified: true }], after: "1" },
          null,
        ];
      expect(input.after).toBe("1");
      return [
        {
          rows: [
            { id: "2", enrolled: true, certified: true },
            { id: "3", enrolled: true, certified: false },
          ],
          after: null,
        },
        null,
      ];
    }
    return query(path, input);
  };
  const mutate = f.client.mutate;
  f.client.mutate = async (path, input) => {
    if (path === "zerotrust.access.publish") {
      f.calls.push(path);
      if (f.state.publicationConflicts > 0) {
        f.state.publicationConflicts--;
        return [
          null,
          new RpcClientError({
            message: "Concurrent catalogue update",
            code: -32009,
            data: { code: "CONFLICT" },
          }),
        ];
      }
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
      for (const grant of input.grants) {
        const original = definitions.get(`${grant.domain}:${grant.generation}`);
        const binding = {
          tenant: "test",
          purpose: "area-key",
          object: grant.domain,
          generation: grant.generation,
          author: "authority:1",
        };
        const before = await openBox(
          original.envelopes[0],
          { ...binding, recipient: "user:1" },
          f.owner.encryptionKey.privateKey,
          f.authorityKey.publicKey,
        );
        const shared = await openBox(
          grant.envelope,
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
      }
      for (const definition of input.domains) {
        expect(definition.policyVersion).toBe(f.get().version);
        expect(definition.generation).toBe("2");
        await verifyDomain(
          definition,
          {
            tenant: "test",
            id: definition.id,
            scope: definition.scope,
            facet: definition.facet,
            generation: "2",
          },
          () => f.authorityKey.publicKey,
        );
      }
      for (const grant of input.grants) {
        grants.push(grant);
        publishedKeys.set(
          `${grant.domain}:${grant.generation}:${grant.envelope.recipient}`,
          grant.envelope,
        );
      }
      for (const definition of input.domains) {
        definitions.set(`${definition.id}:2`, definition);
        pending.delete(definition.id);
      }
      return [{ success: true }, null];
    }
    return mutate(path, input);
  };
  return { ...f, definitions, grants, pending };
}

test("administration binds independently valid metadata to the same technical account", async () => {
  const f = await fixture();
  const alias = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:3",
      ...(await publicIdentity(f.owner)),
    },
    f.authorityKey.privateKey,
  );
  const query = f.client.query;
  f.client.query = async (path, input) => {
    const [value, error] = await query(path, input);
    if (error) return [value, error];
    if (path === "zerotrust.trust.history")
      return [{ ...value, identities: [...value.identities, alias] }, null];
    if (path === "zerotrust.access.snapshot")
      return [{ ...value, subject: "user:3" }, null];
    return [value, null];
  };
  expect(
    (await verifiedAccessContext(f.client, new AbortController().signal))
      .subject,
  ).toBe("user:3");
  await expect(
    administratorPolicyContext(f.client, new AbortController().signal),
  ).rejects.toThrow();
});

test("scoped completion checks only edited areas and preserves another pending rotation", async () => {
  const f = await rotationFixture();
  await finishAccessChanges(f.client, new AbortController().signal, [
    f.a.domain,
  ]);
  expect(f.definitions.has(`${f.a.domain}:2`)).toBe(true);
  expect(f.definitions.has(`${f.b.domain}:2`)).toBe(false);
  expect(f.pending.has(f.b.domain)).toBe(true);
  expect(f.snapshots.length).toBeGreaterThan(0);
  expect(
    f.snapshots.every(
      (input) => input.domains?.length === 1 && input.domains[0] === f.a.domain,
    ),
  ).toBe(true);
});

test("unrelated catalogue conflicts retry from fresh input and remain bounded", async () => {
  const f = await rotationFixture();
  f.state.publicationConflicts = 1;
  await finishAccessChanges(f.client, new AbortController().signal);
  expect(f.pending.size).toBe(0);
  expect(
    f.calls.filter((path) => path === "zerotrust.access.publish"),
  ).toHaveLength(2);
  const blocked = await rotationFixture();
  blocked.state.publicationConflicts = 10;
  await expect(
    finishAccessChanges(blocked.client, new AbortController().signal),
  ).rejects.toBeInstanceOf(RpcClientError);
  expect(
    blocked.calls.filter((path) => path === "zerotrust.access.publish"),
  ).toHaveLength(3);
  expect(blocked.pending.size).toBe(2);
});

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
    expect(
      f.calls.filter((path) => path === "zerotrust.access.publish"),
    ).toHaveLength(conflict ? 2 : 1);
    expect(
      f.calls.some(
        (path) =>
          path === "zerotrust.keys.grant" || path === "zerotrust.domains.put",
      ),
    ).toBe(false);
    if (conflict)
      expect(f.grants.some((grant) => grant.domain === f.b.domain)).toBe(false);
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

test("creation permissions publish edited scopes together and preserve a concurrent unrelated grant", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  expect(await memberCreationAccesses(f.client, "user:2", signal)).toEqual({
    project: false,
    commercial: false,
    tool: false,
    "tool-tracking": false,
  });
  const initial = structuredClone(f.get().rules);
  const concurrent = {
    subject: "user:2",
    scope: "tool:8",
    facet: "procurement",
    actions: ["read"],
    effect: "allow",
  };
  f.state.duringGrant = async () => {
    const { signature, ...current } = f.get();
    f.setPolicy(
      await signPolicy(
        {
          ...current,
          version: String(BigInt(current.version) + 1n),
          rules: [...current.rules, concurrent],
        },
        f.authorityKey.privateKey,
      ),
    );
  };
  await changeCreationAccesses(
    f.client,
    "user:2",
    {
      commercial: true,
      "tool-tracking": true,
    },
    signal,
  );
  expect(f.saved).toHaveLength(1);
  expect(f.capabilities.size).toBe(2);
  for (const capability of f.capabilities.values()) {
    expect(capability.creator.user).toBe("user:2");
    expect(capability.readers.map((reader) => reader.user)).toEqual(["user:1"]);
  }
  const creation = (rule) =>
    rule.subject === "user:2" && rule.scope.startsWith("create:");
  expect(f.get().rules.filter((rule) => !creation(rule))).toEqual([
    ...initial,
    concurrent,
  ]);
  expect(await memberCreationAccesses(f.client, "user:2", signal)).toEqual({
    project: false,
    commercial: true,
    tool: false,
    "tool-tracking": true,
  });
  await changeCreationAccesses(
    f.client,
    "user:2",
    { "tool-tracking": false },
    signal,
  );
  const access = await memberCreationAccesses(f.client, "user:2", signal);
  expect(access.commercial).toBe(true);
  expect(access["tool-tracking"]).toBe(false);
  expect(f.capabilities.size).toBe(2);
});

for (const mode of ["false-capability", "lost-capability", "false"]) {
  test(`creation certificate and policy readback handle ${mode} without false success`, async () => {
    const f = await fixture();
    f.state.mode = mode;
    const signal = new AbortController().signal;
    const work = changeCreationAccesses(
      f.client,
      "user:2",
      { "tool-tracking": true },
      signal,
    );
    if (mode === "lost-capability") {
      await work;
      expect(
        (await memberCreationAccesses(f.client, "user:2", signal))[
          "tool-tracking"
        ],
      ).toBe(true);
      expect(f.saved).toHaveLength(1);
    } else {
      await expect(work).rejects.toThrow();
      expect(
        (await memberCreationAccesses(f.client, "user:2", signal))[
          "tool-tracking"
        ],
      ).toBe(false);
      expect(f.saved).toHaveLength(mode === "false-capability" ? 0 : 1);
    }
  });
}

test("a different valid creation certificate cannot acknowledge the requested delegation", async () => {
  const f = await fixture();
  const query = f.client.query;
  f.client.query = async (path, input) => {
    const reply = await query(path, input);
    if (path !== "zerotrust.creations.capability" || !reply[0]) return reply;
    const { signature, ...candidate } = reply[0];
    const substituted = await certifyCreationCapability(
      { ...candidate, id: "different-delegation" },
      f.authorityKey.privateKey,
    );
    return [substituted, null];
  };
  await expect(
    changeCreationAccesses(
      f.client,
      "user:2",
      { "tool-tracking": true },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.saved).toHaveLength(0);
});

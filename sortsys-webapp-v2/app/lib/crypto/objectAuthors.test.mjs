import { expect, test } from "bun:test";
import {
  ACTIONS,
  bytes,
  certifyCreationCapability,
  certifyIdentity,
  createDelegatedDomain,
  createDomain,
  createManagedDomain,
  certifyKeyAuthority,
  createIdentity,
  domainProof,
  frame,
  sign,
  createOrigin,
  createTenantSetup,
  encryptObject,
  encryptTombstone,
  publicIdentity,
  signPolicy,
  verifyTrustHistory,
} from "@sortsys/zerotrust/sortsys";
import { createObjectAuthorVerifier } from "./objectAuthors";

const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const area = {
  id: "project:4:master-data",
  scope: "project:4",
  facet: "master-data",
};
function permissionsOf(signedPolicy) {
  const { signature, ...permissions } = signedPolicy;
  return permissions;
}
async function fixture(
  readerActions = ["read"],
  created = false,
  selectedArea = area,
) {
  const owner = await createIdentity();
  const reader = await createIdentity();
  const { setup, authorityKey } = await createTenantSetup(
    "test",
    "user:1",
    owner,
    PHRASE,
    { scopes: [{ domain: selectedArea.id, ...selectedArea }] },
  );
  const certificate = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:2",
      ...(await publicIdentity(reader)),
    },
    authorityKey.privateKey,
  );
  const history = await verifyTrustHistory(
    {
      authorities: [{ certificate: setup.authority, transition: null }],
      identities: [setup.owner, certificate],
    },
    {
      tenant: "test",
      generation: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    },
  );
  const roots = new Map();
  const definitions = new Map();
  const calls = [];
  let live = true;
  let alter = (value) => value;
  const signed = await signPolicy(
    {
      tenant: "test",
      version: "2",
      rules: [
        ...setup.policy.rules,
        ...(!created
          ? [
              {
                subject: "user:2",
                scope: selectedArea.scope,
                facet: selectedArea.facet,
                effect: "allow",
                actions: readerActions,
              },
            ]
          : []),
      ],
    },
    authorityKey.privateKey,
  );
  roots.set("2", { generation: "1", policy: signed });
  let domain;
  if (created) {
    const capability = await certifyCreationCapability(
      {
        tenant: "test",
        id: "capability",
        generation: "1",
        namespace: "project",
        creator: certificate,
        readers: [setup.owner],
      },
      authorityKey.privateKey,
    );
    const origin = await createOrigin(
      { tenant: "test", ...selectedArea, capability },
      reader.signingKey.privateKey,
    );
    domain = await createDelegatedDomain({
      origin,
      creatorKey: reader.signingKey.privateKey,
      policyVersion: "2",
      recovery: {
        encryptionKey: setup.authority.recoveryEncryptionKey,
        signingKey: setup.authority.recoverySigningKey,
      },
    });
  } else {
    domain = await createDomain({
      tenant: "test",
      ...selectedArea,
      generation: "1",
      policyVersion: "2",
      authorityGeneration: "1",
      authorityKey: authorityKey.privateKey,
      recovery: {
        encryptionKey: setup.authority.recoveryEncryptionKey,
        signingKey: setup.authority.recoverySigningKey,
      },
      readers: [
        { subject: "user:1", identity: setup.owner },
        { subject: "user:2", identity: certificate },
      ],
    });
  }
  definitions.set("1", domain.definition);
  const client = {
    async query(path, input, options) {
      calls.push({ path, input, options });
      if (path === "zerotrust.policy.getVersion") {
        return [alter(roots.get(input.version)), null];
      }
      if (path === "zerotrust.domains.get") {
        return [definitions.get(input.generation), null];
      }
      if (path === "zerotrust.domains.proof") {
        return [await domainProof(definitions.get(input.generation)), null];
      }
      throw new Error("Unexpected author proof query: " + path);
    },
  };
  const context = {
    account: { tenant: "test" },
    history,
    live() {
      if (!live) {
        throw new Error("Replaced account");
      }
    },
  };
  const verifier = createObjectAuthorVerifier(client, context);
  async function envelope(
    version = "2",
    revision = "1",
    author = "user:2",
    generation = "1",
  ) {
    return encryptObject(
      {
        tenant: "test",
        scope: selectedArea.scope,
        facet: selectedArea.facet,
        object: "project:4:record",
        policyVersion: version,
        revision,
        author,
        generation,
      },
      bytes(JSON.stringify({ secret: "must be authorized before parsing" })),
      domain.key,
      author === "user:1"
        ? owner.signingKey.privateKey
        : reader.signingKey.privateKey,
    );
  }
  return {
    owner,
    reader,
    setup,
    authorityKey,
    roots,
    definitions,
    client,
    context,
    verifier,
    envelope,
    calls,
    domain,
    stop: () => {
      live = false;
    },
    alter: (next) => {
      alter = next;
    },
  };
}

test("a genuinely signed and decryptable reader forgery is rejected before it can become business data", async () => {
  const f = await fixture();
  for (const revision of ["1", "2"]) {
    const packet = await f.envelope("2", revision);
    expect(await f.context.history.signer(packet)).toBeTruthy(); // Former signature-only path accepted it.
    await expect(f.verifier(packet, f.domain.definition)).rejects.toThrow();
  }
  expect(
    await f.verifier(await f.envelope("2", "1", "user:1"), f.domain.definition),
  ).toBeTruthy();
});

test("historical writer rights survive later revocation and one verified proof serves concurrent records", async () => {
  const f = await fixture(["read", "create", "update"]);
  const old = await f.envelope();
  f.roots.set("3", {
    generation: "1",
    policy: await signPolicy(
      { tenant: "test", version: "3", rules: f.setup.policy.rules },
      f.authorityKey.privateKey,
    ),
  });
  const verify = createObjectAuthorVerifier(
    f.client,
    f.context,
    permissionsOf(f.roots.get("3").policy),
  );
  await Promise.all(
    Array.from({ length: 24 }, () => verify(old, f.domain.definition)),
  );
  expect(
    f.calls.filter((call) => call.path === "zerotrust.policy.getVersion")
      .length,
  ).toBe(1);
  expect(f.calls[0].options.strategy).toBe("network-only");
  await expect(
    verify(await f.envelope("3", "2"), f.domain.definition),
  ).rejects.toThrow();
});

test("explicit denial and global suspension override a writer in the recorded policy", async () => {
  for (const suspended of [false, true]) {
    const f = await fixture([...ACTIONS]);
    const { signature, ...original } = f.roots.get("2").policy;
    f.roots.set("2", {
      generation: "1",
      policy: await signPolicy(
        {
          ...original,
          ...(suspended
            ? { suspended: ["user:2"] }
            : {
                rules: [
                  ...original.rules,
                  {
                    subject: "user:2",
                    scope: area.scope,
                    facet: area.facet,
                    effect: "deny",
                    actions: ["create", "update"],
                  },
                ],
              }),
        },
        f.authorityKey.privateKey,
      ),
    });
    await expect(
      f.verifier(await f.envelope(), f.domain.definition),
    ).rejects.toThrow();
  }
});

test("a recorded policy cannot be replaced with another version, authority, tenant or modified rule set", async () => {
  for (const mutate of [
    (value) => ({ ...value, generation: "2" }),
    (value) => ({ ...value, policy: { ...value.policy, version: "3" } }),
    (value) => ({ ...value, policy: { ...value.policy, tenant: "other" } }),
    (value) => ({
      ...value,
      policy: {
        ...value.policy,
        rules: [
          ...value.policy.rules,
          {
            subject: "user:2",
            scope: area.scope,
            facet: area.facet,
            effect: "allow",
            actions: ["create"],
          },
        ],
      },
    }),
  ]) {
    const f = await fixture();
    f.alter(mutate);
    await expect(
      f.verifier(await f.envelope(), f.domain.definition),
    ).rejects.toThrow();
  }
});

test("a failed historical proof is retryable and cannot finish in a replaced account", async () => {
  const f = await fixture(["read", "create"]);
  f.alter(() => null);
  await expect(
    f.verifier(await f.envelope(), f.domain.definition),
  ).rejects.toThrow();
  f.alter((value) => value);
  expect(
    await f.verifier(await f.envelope(), f.domain.definition),
  ).toBeTruthy();
  const g = await fixture(["read", "create"]);
  g.alter((value) => {
    g.stop();
    return value;
  });
  await expect(
    g.verifier(await g.envelope(), g.domain.definition),
  ).rejects.toThrow("Replaced account");
});

test("certified creation rights remain verifiable after key rotation while explicit root denials prevail", async () => {
  const f = await fixture([], true);
  expect(
    await f.verifier(await f.envelope(), f.domain.definition),
  ).toBeTruthy();
  const next = await createDomain({
    tenant: "test",
    ...area,
    generation: "2",
    policyVersion: "3",
    authorityGeneration: "1",
    authorityKey: f.authorityKey.privateKey,
    recovery: {
      encryptionKey: f.setup.authority.recoveryEncryptionKey,
      signingKey: f.setup.authority.recoverySigningKey,
    },
    readers: [{ subject: "user:1", identity: f.setup.owner }],
  });
  const { signature, ...permissions } = f.roots.get("2").policy;
  f.roots.set("3", {
    generation: "1",
    policy: await signPolicy(
      { ...permissions, version: "3" },
      f.authorityKey.privateKey,
    ),
  });
  expect(
    await f.verifier(
      await f.envelope("3", "2", "user:2", "2"),
      next.definition,
    ),
  ).toBeTruthy();
  expect(
    f.calls.filter((call) => call.path === "zerotrust.domains.get").length,
  ).toBe(1);
  f.roots.set("4", {
    generation: "1",
    policy: await signPolicy(
      {
        ...permissions,
        version: "4",
        rules: [
          ...permissions.rules,
          {
            subject: "user:2",
            scope: area.scope,
            facet: area.facet,
            effect: "deny",
            actions: ["update"],
          },
        ],
      },
      f.authorityKey.privateKey,
    ),
  });
  await expect(
    f.verifier(await f.envelope("4", "3", "user:2", "2"), next.definition),
  ).rejects.toThrow();
});

test("immutable staged document parts may use update rights but ordinary new records cannot", async () => {
  const f = await fixture(["read", "update"]);
  const packet = await f.envelope();
  await expect(f.verifier(packet, f.domain.definition)).rejects.toThrow();
  expect(await f.verifier(packet, f.domain.definition, true)).toBeTruthy();
});

test("a key generation cannot authorize contents declared under an earlier policy", async () => {
  const f = await fixture(["read", "create"]);
  await expect(
    f.verifier(await f.envelope("1"), f.domain.definition),
  ).rejects.toThrow();
  expect(f.calls.length).toBe(0);
});

test("a recovered account verifies old writers under the old authority without extending their rights into the new generation", async () => {
  const { recoveryFixture } =
    await import("../../../../sortsys-zerotrust/test/support/recoveryFixture.ts");
  const f = await recoveryFixture();
  const plan = f.plan;
  const history = await verifyTrustHistory(
    {
      authorities: [
        { certificate: f.setup.authority, transition: null },
        {
          certificate: plan.nextSetup.authority,
          transition: {
            sourceAuthority: plan.sourceAuthority,
            transition: plan.transition,
            proof: plan.proof,
            nextProof: plan.nextProof,
          },
        },
      ],
      identities: [f.setup.owner, plan.nextSetup.owner],
    },
    {
      tenant: "test",
      generation: "2",
      recoverySigningKey: plan.transition.nextRecoverySigningKey,
    },
  );
  const verifier = createObjectAuthorVerifier(
    {
      async query(path, input) {
        expect(path).toBe("zerotrust.policy.getVersion");
        expect(input.version).toBe("1");
        return [{ generation: "1", policy: f.setup.policy }, null];
      },
    },
    { account: { tenant: "test" }, history, live() {} },
    permissionsOf(plan.nextSetup.policy),
  );
  const context = {
    tenant: "test",
    scope: f.definition.scope,
    facet: f.definition.facet,
    object: "position:1",
    revision: "1",
    generation: "1",
    policyVersion: "1",
    author: f.setup.owner.user,
  };
  const old = await encryptObject(
    context,
    bytes("historical"),
    f.key,
    f.owner.signingKey.privateKey,
  );
  expect(await verifier(old, f.definition)).toBeTruthy();
  const forged = await encryptObject(
    { ...context, generation: "2", policyVersion: "2" },
    bytes("new unauthorized"),
    f.key,
    f.owner.signingKey.privateKey,
  );
  await expect(verifier(forged, plan.domains[0])).rejects.toThrow();
}, 15000);

test("only recorded delete rights authorize an empty tombstone; delete rights cannot sign ordinary edits", async () => {
  for (const actions of [["read"], ["read", "update"], ["read", "delete"]]) {
    const f = await fixture(actions);
    const packet = await encryptTombstone(
      {
        tenant: "test",
        scope: area.scope,
        facet: area.facet,
        object: "project:4:record",
        revision: "2",
        generation: "1",
        policyVersion: "2",
        author: "user:2",
      },
      f.domain.key,
      f.reader.signingKey.privateKey,
    );
    if (actions.includes("delete")) {
      expect(await f.verifier(packet, f.domain.definition)).toBeTruthy();
      await expect(
        f.verifier(await f.envelope("2", "2"), f.domain.definition),
      ).rejects.toThrow();
    } else {
      await expect(f.verifier(packet, f.domain.definition)).rejects.toThrow();
    }
  }
});

test("ordinary create/update rights cannot forge an immutable absence decision, including staged fallback", async () => {
  const area = {
    id: "absence:2:personnel",
    scope: "absence:2",
    facet: "personnel",
  };
  for (const actions of [
    ["read", "create", "update", "delete"],
    ["read", "approve"],
  ]) {
    const f = await fixture(actions, false, area);
    const { signature, ...policy } = f.roots.get("2").policy;
    f.roots.set("2", {
      generation: "1",
      policy: await signPolicy(
        {
          ...policy,
          rules: [
            ...policy.rules,
            {
              subject: "user:2",
              scope: area.scope,
              facet: "master-data",
              effect: "allow",
              actions: ["read"],
            },
          ],
        },
        f.authorityKey.privateKey,
      ),
    });
    const context = {
      tenant: "test",
      scope: area.scope,
      facet: area.facet,
      object: "absence:2:decision:3",
      policyVersion: "2",
      revision: "1",
      author: "user:2",
      generation: "1",
    };
    const decision = await encryptObject(
      context,
      bytes(JSON.stringify({ status: "approved" })),
      f.domain.key,
      f.reader.signingKey.privateKey,
    );
    for (const staged of [false, true]) {
      if (actions.includes("approve")) {
        expect(
          await f.verifier(decision, f.domain.definition, staged),
        ).toBeTruthy();
      } else {
        await expect(
          f.verifier(decision, f.domain.definition, staged),
        ).rejects.toThrow();
      }
    }
    const next = await encryptObject(
      { ...context, revision: "2" },
      bytes("{}"),
      f.domain.key,
      f.reader.signingKey.privateKey,
    );
    await expect(f.verifier(next, f.domain.definition)).rejects.toThrow();
  }
});

test("recorded write rights never replace the native prerequisite of recorded read access", async () => {
  for (const actions of [["create"], ["update"]]) {
    const f = await fixture(actions);
    await expect(
      f.verifier(
        await f.envelope("2", actions.includes("create") ? "1" : "2"),
        f.domain.definition,
      ),
    ).rejects.toThrow();
  }
});

test("managed key definitions require recorded Grant and Read rights at their signed policy version", async () => {
  for (const actions of [
    ["read", "update", "grant"],
    ["read", "update"],
    ["update", "grant"],
  ]) {
    const f = await fixture(actions);
    const certificate = await certifyKeyAuthority(
      {
        tenant: "test",
        generation: "1",
        scope: area.scope,
        facet: area.facet,
        holder: f.context.history.identityCertificate("user:2"),
      },
      f.authorityKey.privateKey,
    );
    const made = await createManagedDomain({
      tenant: "test",
      ...area,
      generation: "2",
      policyVersion: "2",
      keyAuthority: certificate,
      signingKey: f.reader.signingKey.privateKey,
      recovery: {
        encryptionKey: f.setup.authority.recoveryEncryptionKey,
        signingKey: f.setup.authority.recoverySigningKey,
      },
      readers: [{ subject: "user:2", identity: certificate.holder }],
    });
    f.definitions.set("2", made.definition);
    const publicVerifier = createObjectAuthorVerifier(f.client, {
      ...f.context,
      account: { tenant: "test" },
    });
    const control = await signedControl(f);
    const replies = await Promise.allSettled([
      f.verifier.definition(made.definition, {
        tenant: "test",
        ...area,
        generation: "2",
      }),
      publicVerifier.control(control.value, control.signedFrame, {
        all: [{ facet: area.facet, action: "update", keyGeneration: "2" }],
      }),
    ]);
    if (actions.includes("read") && actions.includes("grant")) {
      expect(replies.map((reply) => reply.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect(replies[0].value.proof).toBe(made.definition.proof);
      const original = permissionsOf(f.roots.get("2").policy);
      f.roots.set("3", {
        generation: "1",
        policy: await signPolicy(
          {
            ...original,
            version: "3",
            rules: original.rules.map((rule) => ({
              ...rule,
              actions: rule.actions.filter((action) => action !== "grant"),
            })),
          },
          f.authorityKey.privateKey,
        ),
      });
      const future = await createManagedDomain({
        tenant: "test",
        ...area,
        generation: "3",
        policyVersion: "3",
        keyAuthority: certificate,
        signingKey: f.reader.signingKey.privateKey,
        recovery: {
          encryptionKey: f.setup.authority.recoveryEncryptionKey,
          signingKey: f.setup.authority.recoverySigningKey,
        },
        readers: [{ subject: "user:2", identity: certificate.holder }],
      });
      await expect(
        f.verifier.definition(future.definition, {
          tenant: "test",
          ...area,
          generation: "3",
        }),
      ).rejects.toThrow();
      expect(
        (
          await f.verifier.definition(made.definition, {
            tenant: "test",
            ...area,
            generation: "2",
          })
        ).proof,
      ).toBe(made.definition.proof);
    } else {
      expect(replies.map((reply) => reply.status)).toEqual([
        "rejected",
        "rejected",
      ]);
    }
  }
});

async function signedControl(fixture, version = "2") {
  const signedFrame = frame("sortsys/test-control/v1", [
    "signed native target",
    version,
  ]);
  const value = {
    tenant: "test",
    scope: area.scope,
    generation: "1",
    policyVersion: version,
    author: "user:2",
    signature: await sign(fixture.reader.signingKey.privateKey, signedFrame),
  };
  return { value, signedFrame };
}

test("signed control records reject a certified reader and retain historical writer rights", async () => {
  for (const actions of [["read"], ["read", "update"]]) {
    const current = await fixture(actions);
    const control = await signedControl(current);
    const requirements = { all: [{ facet: "master-data", action: "update" }] };
    if (actions.includes("update")) {
      expect(
        await current.verifier.control(
          control.value,
          control.signedFrame,
          requirements,
        ),
      ).toBeTruthy();
    } else {
      await expect(
        current.verifier.control(
          control.value,
          control.signedFrame,
          requirements,
        ),
      ).rejects.toThrow();
    }
    expect(
      current.calls.some((call) => call.path === "zerotrust.keys.get"),
    ).toBe(false);
  }
  const current = await fixture(["read", "update"]);
  current.roots.set("3", {
    generation: "1",
    policy: await signPolicy(
      { tenant: "test", version: "3", rules: current.setup.policy.rules },
      current.authorityKey.privateKey,
    ),
  });
  const verifier = createObjectAuthorVerifier(
    current.client,
    current.context,
    permissionsOf(current.roots.get("3").policy),
  );
  const historical = await signedControl(current);
  expect(
    await verifier.control(historical.value, historical.signedFrame, {
      all: [{ facet: "master-data", action: "update" }],
    }),
  ).toBeTruthy();
  const revoked = await signedControl(current, "3");
  await expect(
    verifier.control(revoked.value, revoked.signedFrame, {
      all: [{ facet: "master-data", action: "update" }],
    }),
  ).rejects.toThrow();
});

test("control records use certified creation rights, explicit denials and the policy's authority generation", async () => {
  const current = await fixture([], true);
  const control = await signedControl(current);
  const requirements = { all: [{ facet: "master-data", action: "update" }] };
  expect(
    await current.verifier.control(
      control.value,
      control.signedFrame,
      requirements,
    ),
  ).toBeTruthy();
  await expect(
    current.verifier.control(
      { ...control.value, generation: "2" },
      control.signedFrame,
      requirements,
    ),
  ).rejects.toThrow();
  await expect(
    current.verifier.control(
      control.value,
      frame("other-frame", []),
      requirements,
    ),
  ).rejects.toThrow();
  const { signature, ...permissions } = current.roots.get("2").policy;
  current.roots.set("3", {
    generation: "1",
    policy: await signPolicy(
      {
        ...permissions,
        version: "3",
        rules: [
          ...permissions.rules,
          {
            subject: "user:2",
            scope: area.scope,
            facet: area.facet,
            effect: "deny",
            actions: ["update"],
          },
        ],
      },
      current.authorityKey.privateKey,
    ),
  });
  const denied = await signedControl(current, "3");
  await expect(
    current.verifier.control(denied.value, denied.signedFrame, requirements),
  ).rejects.toThrow();
});

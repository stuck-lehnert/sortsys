import { expect, test } from "bun:test";
import {
  ACTIONS,
  base64,
  certifyIdentity,
  createIdentity,
  createZeroTrust,
  publicIdentity,
  type Action,
} from "../src/index";

async function fixture() {
  const framework = createZeroTrust({ facets: ["notes", "billing"] });
  const authority = await createIdentity();
  async function member(user: string) {
    const identity = await createIdentity();
    const certificate = await certifyIdentity(
      {
        tenant: "laboratory:alpha",
        generation: "1",
        user,
        ...(await publicIdentity(identity)),
      },
      authority.signingKey.privateKey,
    );
    return { identity, certificate };
  }
  const manager = await member("researcher:lee");
  const other = await member("researcher:kai");
  const outsider = await member("researcher:lin");
  const root = await framework.policies.signPolicy(
    {
      tenant: "laboratory:alpha",
      version: "1",
      suspended: [],
      rules: [
        {
          subject: "researcher:owner",
          scope: "experiment:1",
          facet: "notes",
          effect: "allow",
          actions: [...ACTIONS],
        },
        {
          subject: manager.certificate.user,
          scope: "experiment:1",
          facet: "notes",
          effect: "allow",
          actions: [...ACTIONS],
        },
        {
          subject: other.certificate.user,
          scope: "experiment:2",
          facet: "billing",
          effect: "allow",
          actions: ["read", "grant"],
        },
        {
          subject: other.certificate.user,
          scope: "experiment:1",
          facet: "notes",
          effect: "allow",
          actions: ["read", "grant"],
        },
        {
          subject: "researcher:ada",
          scope: "preferences:ada",
          facet: "notes",
          effect: "allow",
          actions: [...ACTIONS],
        },
        {
          subject: manager.certificate.user,
          scope: "experiment:1",
          facet: "notes",
          effect: "deny",
          actions: ["delete"],
        },
        {
          subject: "researcher:ada",
          scope: "experiment:1",
          facet: "notes",
          effect: "allow",
          actions: ["read"],
        },
        {
          subject: "researcher:ada",
          scope: "experiment:1",
          facet: "notes",
          effect: "deny",
          actions: ["delete"],
        },
      ],
    },
    authority.signingKey.privateKey,
  );
  const rootPermissions = (
    await framework.policies.verifyPolicy(root, {
      tenant: root.tenant,
      authority: authority.signingKey.publicKey,
    })
  ).permissions;
  async function profile(
    actions: Action[] = ["read", "update"],
    version = "2",
  ) {
    return framework.policies.administrativeProfiles.sign(
      {
        tenant: root.tenant,
        rootSignature: root.signature,
        version,
        subject: "researcher:ada",
        scope: "experiment:1",
        facet: "notes",
        actions,
        author: manager.certificate,
      },
      manager.identity.signingKey.privateKey,
    );
  }
  const value = await profile();
  const delegated = await framework.policies.signAdministrativePolicy(
    {
      root,
      profiles: [value],
      author: manager.certificate,
      previousSignature: root.signature,
      version: "2",
    },
    manager.identity.signingKey.privateKey,
  );
  return {
    framework,
    authority,
    manager,
    other,
    outsider,
    root,
    rootPermissions,
    profile,
    delegated,
  };
}

test("a manager changes an ordinary profile with its own key and an independently verifiable root checkpoint", async () => {
  const f = await fixture();
  const checked = await f.framework.policies.verifyPolicy(f.delegated, {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  });
  const access = f.framework.policies.compilePolicy(checked.permissions, [
    "researcher:ada",
  ]);
  expect(access.allows("experiment:1", "notes", "read")).toBe(true);
  expect(access.allows("experiment:1", "notes", "update")).toBe(true);
  expect(access.allows("experiment:1", "notes", "delete")).toBe(false);
  expect(access.allows("experiment:1", "notes", "grant")).toBe(false);
  expect(
    f.framework.policies.administrativeReplacement(
      f.root,
      f.delegated,
      f.manager.certificate,
    ),
  ).toBe(true);
  // JSON property order is not part of a rule's cryptographic meaning.
  const reordered = {
    ...f.delegated,
    rules: f.delegated.rules.map(({ subject, ...rest }) => ({
      ...rest,
      subject,
    })),
  };
  expect(
    (
      await f.framework.policies.verifyPolicy(reordered, {
        tenant: f.root.tenant,
        authority: f.authority.signingKey.publicKey,
      })
    ).signature,
  ).toBe(f.delegated.signature);
});

test("only the authority can continue delegated profiles at a new write version", async () => {
  const f = await fixture();
  const binding = base64(crypto.getRandomValues(new Uint8Array(32)));
  const expected = {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  };
  const before = await f.framework.policies.verifyPolicy(f.delegated, expected);
  const continued = await f.framework.policies.signPolicyContinuation(
    f.delegated,
    binding,
    f.authority.signingKey.privateKey,
  );
  const after = await f.framework.policies.verifyPolicy(continued, expected);
  expect(after.permissions).toEqual({ ...before.permissions, version: "3" });
  expect(after.administration).toEqual({
    ...before.administration!,
    continuation: binding,
    previousSignature: before.signature,
  });
  const forged = await f.framework.policies.signPolicyContinuation(
    f.delegated,
    binding,
    f.manager.identity.signingKey.privateKey,
  );
  await expect(
    f.framework.policies.verifyPolicy(forged, expected),
  ).rejects.toThrow();
  expect(
    f.framework.policies.administrativeReplacement(
      f.delegated,
      continued,
      f.manager.certificate,
    ),
  ).toBe(false);
  const subsequent = await f.framework.policies.signAdministrativePolicy(
    {
      root: f.root,
      profiles: [await f.profile(["read"], "4")],
      author: f.manager.certificate,
      previousSignature: continued.signature,
      version: "4",
    },
    f.manager.identity.signingKey.privateKey,
  );
  expect(
    f.framework.policies.administrativeReplacement(
      continued,
      subsequent,
      f.manager.certificate,
    ),
  ).toBe(true);
  await f.framework.policies.verifyPolicy(subsequent, expected);

  const last = await f.framework.policies.signAdministrativePolicy(
    {
      root: f.root,
      profiles: [await f.profile()],
      author: f.manager.certificate,
      previousSignature: continued.signature,
      version: "9223372036854775807",
    },
    f.manager.identity.signingKey.privateKey,
  );
  await f.framework.policies.verifyPolicy(last, expected);
  await expect(
    f.framework.policies.signPolicyContinuation(
      last,
      binding,
      f.authority.signingKey.privateKey,
    ),
  ).rejects.toThrow();
});

test("a delegated replacement must change at least one authorized profile", async () => {
  const f = await fixture();
  for (const previous of [f.root, f.delegated]) {
    const candidate = await f.framework.policies.signAdministrativePolicy(
      {
        root: f.root,
        profiles: previous.administration?.profiles ?? [],
        author: f.manager.certificate,
        previousSignature: previous.signature,
        version: (BigInt(previous.version) + 1n).toString(),
      },
      f.manager.identity.signingKey.privateKey,
    );
    await f.framework.policies.verifyPolicy(candidate, {
      tenant: f.root.tenant,
      authority: f.authority.signingKey.publicKey,
    });
    expect(
      f.framework.policies.administrativeReplacement(
        previous,
        candidate,
        f.manager.certificate,
      ),
    ).toBe(false);
  }
});

test("ungranted areas, protected managers, root limits on the manager and administrative escalation fail", async () => {
  const f = await fixture();
  const original = f.delegated.administration!.profiles[0]!;
  for (const changed of [
    { scope: "experiment:2", facet: "billing" as const },
    { subject: "researcher:owner" },
    { subject: f.other.certificate.user },
    { actions: ["read", "delete"] as Action[] },
    { actions: ["grant"] as Action[] },
  ]) {
    await expect(
      (async () => {
        const profile = await f.framework.policies.administrativeProfiles.sign(
          { ...original, ...changed },
          f.manager.identity.signingKey.privateKey,
        );
        return f.framework.policies.administrativeProfiles.verify(profile, {
          root: f.rootPermissions,
          signature: f.root.signature,
          authority: f.authority.signingKey.publicKey,
          generation: "1",
        });
      })(),
    ).rejects.toThrow();
  }
  const overreach = await f.framework.policies.administrativeProfiles.sign(
    {
      ...original,
      scope: "experiment:2",
      facet: "billing",
      author: f.other.certificate,
      actions: ["read", "update"],
    },
    f.other.identity.signingKey.privateKey,
  );
  await expect(
    f.framework.policies.administrativeProfiles.verify(overreach, {
      root: f.rootPermissions,
      signature: f.root.signature,
      authority: f.authority.signingKey.publicKey,
      generation: "1",
    }),
  ).rejects.toThrow();
});

test("the signing actor must itself have a certified management grant", async () => {
  const f = await fixture();
  const attempted = await f.framework.policies.signAdministrativePolicy(
    {
      ...f.delegated.administration!,
      author: f.outsider.certificate,
      version: "2",
    },
    f.outsider.identity.signingKey.privateKey,
  );
  await expect(
    f.framework.policies.verifyPolicy(attempted, {
      tenant: f.root.tenant,
      authority: f.authority.signingKey.publicKey,
    }),
  ).rejects.toThrow();
});

test("tampering with profile, signer, generation, root or derived rules is rejected", async () => {
  const f = await fixture();
  const attempts = [
    (value: typeof f.delegated) => {
      value.rules = [];
    },
    (value: typeof f.delegated) => {
      value.rules.reverse();
    },
    (value: typeof f.delegated) => {
      value.rules[0]!.actions.reverse();
    },
    (value: typeof f.delegated) => {
      value.rules[0]!.effect = "deny";
    },
    (value: typeof f.delegated) => {
      delete value.suspended;
    },
    (value: typeof f.delegated) => {
      value.suspended = ["researcher:ada"];
    },
    (value: typeof f.delegated) => {
      value.administration!.profiles[0]!.actions = ["read"];
    },
    (value: typeof f.delegated) => {
      value.administration!.author = f.other.certificate;
    },
    (value: typeof f.delegated) => {
      value.administration!.profiles[0]!.author.generation = "2";
    },
    (value: typeof f.delegated) => {
      value.administration!.root.version = "2";
    },
    (value: typeof f.delegated) => {
      value.administration!.root.administration = structuredClone(
        value.administration!,
      );
    },
    (value: typeof f.delegated) => {
      value.administration!.profiles.push(
        structuredClone(value.administration!.profiles[0]!),
      );
    },
  ];
  for (const change of attempts) {
    const candidate = structuredClone(f.delegated);
    change(candidate);
    await expect(
      f.framework.policies.verifyPolicy(candidate, {
        tenant: f.root.tenant,
        authority: f.authority.signingKey.publicKey,
      }),
    ).rejects.toThrow();
  }
});

test("a new primary checkpoint revokes management without losing already granted employee actions", async () => {
  const f = await fixture();
  const checked = await f.framework.policies.verifyPolicy(f.delegated, {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  });
  const checkpoint = await f.framework.policies.signPolicy(
    {
      ...checked.permissions,
      version: "3",
      rules: checked.permissions.rules.map((rule) =>
        rule.subject === f.manager.certificate.user
          ? {
              ...rule,
              actions: rule.actions.filter((action) => action !== "grant"),
            }
          : rule,
      ),
    },
    f.authority.signingKey.privateKey,
  );
  const current = await f.framework.policies.verifyPolicy(checkpoint, {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  });
  expect(
    f.framework.policies
      .compilePolicy(current.permissions, ["researcher:ada"])
      .allows("experiment:1", "notes", "update"),
  ).toBe(true);
  expect(
    f.framework.policies.canAdminister(
      current.permissions,
      f.manager.certificate.user,
    ),
  ).toBe(false);
  const replay = await f.framework.policies.signAdministrativePolicy(
    {
      ...f.delegated.administration!,
      version: "4",
      previousSignature: checkpoint.signature,
    },
    f.manager.identity.signingKey.privateKey,
  );
  // The old signature remains historical evidence, but cannot replace the live checkpoint.
  expect(
    f.framework.policies.administrativeReplacement(
      checkpoint,
      replay,
      f.manager.certificate,
    ),
  ).toBe(false);
});

test("a manager cannot drop or replay another profile when publishing a new head", async () => {
  const f = await fixture();
  const currentProfile = await f.profile(["read", "update", "approve"], "3");
  const current = await f.framework.policies.signAdministrativePolicy(
    {
      root: f.root,
      profiles: [currentProfile],
      author: f.manager.certificate,
      previousSignature: f.delegated.signature,
      version: "3",
    },
    f.manager.identity.signingKey.privateKey,
  );
  const dropped = await f.framework.policies.signAdministrativePolicy(
    {
      root: f.root,
      profiles: [],
      author: f.other.certificate,
      previousSignature: current.signature,
      version: "4",
    },
    f.other.identity.signingKey.privateKey,
  );
  const replayed = await f.framework.policies.signAdministrativePolicy(
    {
      ...f.delegated.administration!,
      previousSignature: current.signature,
      version: "4",
    },
    f.manager.identity.signingKey.privateKey,
  );
  expect(
    f.framework.policies.administrativeReplacement(
      current,
      dropped,
      f.other.certificate,
    ),
  ).toBe(false);
  expect(
    f.framework.policies.administrativeReplacement(
      current,
      replayed,
      f.manager.certificate,
    ),
  ).toBe(false);
  expect(
    f.framework.policies.administrativeReplacement(
      f.root,
      f.delegated,
      f.outsider.certificate,
    ),
  ).toBe(false);
});

test("an unrelated primary checkpoint does not accidentally freeze ordinary member profiles", async () => {
  const f = await fixture();
  const checked = await f.framework.policies.verifyPolicy(f.delegated, {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  });
  const checkpoint = await f.framework.policies.signPolicy(
    { ...checked.permissions, version: "3" },
    f.authority.signingKey.privateKey,
  );
  const profile = await f.framework.policies.administrativeProfiles.sign(
    {
      ...f.delegated.administration!.profiles[0]!,
      rootSignature: checkpoint.signature,
      version: "4",
      actions: ["read", "update", "approve"],
    },
    f.manager.identity.signingKey.privateKey,
  );
  const next = await f.framework.policies.signAdministrativePolicy(
    {
      root: checkpoint,
      profiles: [profile],
      author: f.manager.certificate,
      previousSignature: checkpoint.signature,
      version: "4",
    },
    f.manager.identity.signingKey.privateKey,
  );
  const result = await f.framework.policies.verifyPolicy(next, {
    tenant: f.root.tenant,
    authority: f.authority.signingKey.publicKey,
  });
  expect(
    f.framework.policies
      .compilePolicy(result.permissions, ["researcher:ada"])
      .allows("experiment:1", "notes", "approve"),
  ).toBe(true);
  expect(
    f.framework.policies.administrativeReplacement(
      checkpoint,
      next,
      f.manager.certificate,
    ),
  ).toBe(true);
});

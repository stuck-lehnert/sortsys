import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { server } from "@serenity-kit/opaque";
import {
  accountRequestFingerprint,
  areaKey,
  base64,
  bytes,
  createAccountDataKey,
  createIdentity,
  createRecoveryPhrase,
  createZeroTrust,
  importSigningKey,
  InvalidProtectedData,
  type ObjectContext,
  opaqueReady,
  openBox,
  type Policy,
  randomSecret,
  recoveryIdentity,
  sign,
  VerifiedStore,
  verify,
} from "../src/index";

const context: ObjectContext<"patient-notes"> = {
  tenant: "practice:alpha",
  scope: "patient:ada",
  facet: "patient-notes",
  object: "note:1",
  revision: "1",
  generation: "1",
  policyVersion: "1",
  author: "doctor:lee",
};

test("the reusable entry never imports sortsys application rules", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const pending = [new URL("../src/index.ts", import.meta.url)];
  const visited = new Set<string>();
  while (pending.length) {
    const module = pending.pop()!;
    if (visited.has(module.href)) continue;
    visited.add(module.href);
    for (const dependency of transpiler.scan(readFileSync(module, "utf8"))
      .imports) {
      if (!dependency.path.startsWith(".")) continue;
      pending.push(new URL(`${dependency.path}.ts`, module));
    }
  }
  for (const adapter of [
    "sortsys",
    "objects",
    "policy",
    "authority",
    "domains",
    "creation",
    "documents",
    "absenceRecords",
    "stockRecords",
    "timestampTargets",
  ]) {
    expect(
      visited.has(new URL(`../src/${adapter}.ts`, import.meta.url).href),
    ).toBe(false);
  }
});

test("an unrelated application encrypts its own facet and verifies signed permissions", async () => {
  const framework = createZeroTrust({
    facets: ["patient-notes", "appointments"],
  });
  const doctor = await createIdentity();
  const key = await areaKey();
  const body = bytes("Confidential consultation");
  const encrypted = await framework.objects.encryptObject(
    context,
    body,
    key,
    doctor.signingKey.privateKey,
  );
  expect(
    await framework.objects.decryptObject(
      encrypted,
      context,
      key,
      doctor.signingKey.publicKey,
    ),
  ).toEqual(body);

  const permissions: Policy<"patient-notes" | "appointments"> = {
    tenant: context.tenant,
    version: "1",
    rules: [
      {
        subject: context.author,
        scope: context.scope,
        facet: context.facet,
        actions: ["read", "update"],
        effect: "allow",
      },
    ],
  };
  const signed = await framework.policies.signPolicy(
    permissions,
    doctor.signingKey.privateKey,
  );
  const verified = await framework.policies.verifyPolicy(signed, {
    tenant: context.tenant,
    authority: doctor.signingKey.publicKey,
  });
  expect(
    framework.policies
      .compilePolicy(verified.permissions, [context.author])
      .allows(context.scope, context.facet, "update"),
  ).toBe(true);
  await expect(
    framework.policies.verifyPolicy(signed, {
      tenant: "practice:other",
      authority: doctor.signingKey.publicKey,
    }),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
  await expect(
    framework.policies.verifyPolicy(
      { ...signed, version: "2" },
      {
        tenant: context.tenant,
        authority: doctor.signingKey.publicKey,
      },
    ),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("independent framework instances cannot change each other's accepted vocabulary", () => {
  const facets = ["patient-notes"];
  const medical = createZeroTrust({ facets });
  const inventory = createZeroTrust({ facets: ["warehouse"] });
  facets.push("warehouse");
  expect(() =>
    medical.objects.objectContext({ ...context, facet: "warehouse" }),
  ).toThrow(InvalidProtectedData);
  expect(() => inventory.objects.objectContext(context)).toThrow(
    InvalidProtectedData,
  );
  expect(() => createZeroTrust({ facets: ["duplicate", "duplicate"] })).toThrow(
    InvalidProtectedData,
  );
  expect(() => createZeroTrust({ facets: [] })).toThrow(InvalidProtectedData);
});

test("denials, account suspension and unknown rule origins fail closed for custom subjects", () => {
  const { policies } = createZeroTrust({ facets: ["patient-notes"] });
  const allow = {
    subject: context.author,
    scope: context.scope,
    facet: context.facet,
    actions: ["read"] as const,
    effect: "allow" as const,
  };
  const permissions = policies.policy({
    tenant: context.tenant,
    version: "1",
    rules: [{ ...allow, actions: [...allow.actions] }],
  });
  const denied = policies.policy({
    ...permissions,
    rules: [...permissions.rules, { ...allow, effect: "deny" }],
  });
  expect(
    policies
      .compilePolicy(denied, [context.author])
      .allows(context.scope, context.facet, "read"),
  ).toBe(false);
  expect(
    policies.compileReadership(denied)(context.scope, context.facet),
  ).toEqual([]);
  const suspended = policies.policy({
    ...permissions,
    suspended: [context.author],
  });
  expect(
    policies
      .compilePolicy(suspended, [context.author])
      .allows(context.scope, context.facet, "read"),
  ).toBe(false);
  expect(() =>
    policies.policy({
      ...permissions,
      rules: [{ ...allow, origin: "invented-privilege" }],
    }),
  ).toThrow(InvalidProtectedData);
});

test("a reusable content store retains the last schema-valid signed value", async () => {
  const { objects } = createZeroTrust({ facets: ["patient-notes"] });
  const author = await createIdentity();
  const key = await areaKey();
  const store = new VerifiedStore({
    objects,
    context,
    schema: {
      decode(value: unknown): { diagnosis: string } {
        if (
          !value ||
          typeof value !== "object" ||
          !("diagnosis" in value) ||
          typeof value.diagnosis !== "string"
        ) {
          throw new InvalidProtectedData();
        }
        return { diagnosis: value.diagnosis };
      },
    },
    key: async () => key,
    signer: async () => author.signingKey.publicKey,
  });
  const valid = await store.encrypt(
    context,
    { diagnosis: "healthy" },
    key,
    author.signingKey.privateKey,
  );
  expect((await store.receive(context.object, valid)).kind).toBe("verified");
  const invalid = await objects.encryptObject(
    { ...context, revision: "2" },
    bytes('{"diagnosis":42}'),
    key,
    author.signingKey.privateKey,
  );
  expect(await store.receive(context.object, invalid)).toEqual({
    kind: "invalid",
    rejectedRevision: "2",
    lastGood: { revision: "1", value: { diagnosis: "healthy" } },
  });
});

test("request fingerprints depend on the stable data key and their exact purpose", async () => {
  const key = await createAccountDataKey();
  const fingerprint = () =>
    accountRequestFingerprint(key, "example/order/v1", "tenant", "member:1", {
      count: 3,
    });
  const original = await fingerprint();
  expect(await fingerprint()).toBe(original);
  expect(
    await accountRequestFingerprint(
      key,
      "example/payment/v1",
      "tenant",
      "member:1",
      { count: 3 },
    ),
  ).not.toBe(original);
  expect(
    await accountRequestFingerprint(
      key,
      "example/order/v1",
      "other",
      "member:1",
      { count: 3 },
    ),
  ).not.toBe(original);
  expect(
    await accountRequestFingerprint(
      await createAccountDataKey(),
      "example/order/v1",
      "tenant",
      "member:1",
      { count: 3 },
    ),
  ).not.toBe(original);
});

test("another application performs two seed recoveries and retains its historical content", async () => {
  await opaqueReady;
  let administrator = 0;
  const framework = createZeroTrust({
    facets: ["patient-notes", "appointments"],
    recovery: {
      createAdministrator: () => {
        administrator += 1;
        return {
          subject: `doctor:recovered-${administrator}`,
          username: `recovery-${administrator}`,
        };
      },
    },
  });
  const owner = await createIdentity();
  const firstPhrase = createRecoveryPhrase();
  const secondPhrase = createRecoveryPhrase();
  const thirdPhrase = createRecoveryPhrase();
  const { setup, authorityKey } = await framework.setup.createTenantSetup(
    context.tenant,
    context.author,
    owner,
    firstPhrase,
  );
  const domain = await framework.domains.createDomain({
    tenant: context.tenant,
    id: "patient:ada:notes-key",
    scope: context.scope,
    facet: context.facet,
    generation: "1",
    policyVersion: "1",
    authorityGeneration: "1",
    authorityKey: authorityKey.privateKey,
    recovery: {
      encryptionKey: setup.authority.recoveryEncryptionKey,
      signingKey: setup.authority.recoverySigningKey,
    },
    readers: [{ subject: context.author, identity: setup.owner }],
  });
  const plaintext = bytes("Historical confidential consultation");
  const encrypted = await framework.objects.encryptObject(
    context,
    plaintext,
    domain.key,
    owner.signingKey.privateKey,
  );
  const serverSetup = server.createSetup();
  const transmitted: string[] = [];
  let expectedRecoveryKey = setup.authority.recoverySigningKey;
  const password = "synthetic-framework-password";
  const register = async (input: {
    tenant: string;
    challengeId: string;
    username: string;
    registrationRequest: string;
    proof: string;
  }) => {
    transmitted.push(JSON.stringify(input));
    await verify(
      await importSigningKey(expectedRecoveryKey),
      input.proof,
      framework.recovery.recoveryRegistrationFrame(
        input.tenant,
        input.challengeId,
        input.username,
        input.registrationRequest,
      ),
    );
    return server.createRegistrationResponse({
      serverSetup,
      userIdentifier: `${input.tenant}/${input.username}`,
      registrationRequest: input.registrationRequest,
    });
  };
  const first = await framework.recovery.prepareRecovery({
    oldPhrase: firstPhrase,
    newPhrase: secondPhrase,
    password,
    register,
    source: {
      challengeId: `challenge:${base64(randomSecret())}`,
      challenge: base64(randomSecret()),
      authority: setup.authority,
      catalog: setup.catalog,
      catalogVersion: "1",
      policyVersion: "1",
      domains: [
        {
          id: domain.definition.id,
          scope: context.scope,
          facet: context.facet,
          generation: "1",
        },
      ],
      keys: [domain.definition.recoveryEnvelope],
      domainProofs: [domain.definition],
    },
  });
  await framework.recovery.verifyRecoveryTransition(first.plan);
  expect(first.plan.nextSetup.owner.user).toBe("doctor:recovered-1");
  const history = await framework.verifyTrustHistory(
    {
      authorities: [
        { certificate: setup.authority, transition: null },
        {
          certificate: first.plan.nextSetup.authority,
          transition: {
            sourceAuthority: setup.authority,
            transition: first.plan.transition,
            proof: first.plan.proof,
            nextProof: first.plan.nextProof,
          },
        },
      ],
      identities: [setup.owner, first.plan.nextSetup.owner],
    },
    {
      tenant: context.tenant,
      generation: "2",
      recoverySigningKey: first.plan.nextSetup.authority.recoverySigningKey,
    },
  );
  const statement = bytes(
    "Public migration attestation for another application",
  );
  const statementProof = await sign(owner.signingKey.privateKey, statement);
  await history.verifyIdentityProof(
    context.author,
    "1",
    statementProof,
    statement,
  );
  await expect(
    history.verifyIdentityProof(context.author, "2", statementProof, statement),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    history.verifyIdentityProof("doctor:other", "1", statementProof, statement),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    history.verifyIdentityProof(
      context.author,
      "1",
      statementProof,
      bytes("Different statement"),
    ),
  ).rejects.toThrow(InvalidProtectedData);
  const archived = first.plan.oldKeyEnvelopes[0]!;
  const rawKey = await openBox(
    archived,
    {
      tenant: context.tenant,
      purpose: "area-key",
      object: domain.definition.id,
      generation: "1",
      recipient: first.plan.nextSetup.owner.user,
      author: "authority:2",
    },
    first.identity.encryptionKey.privateKey,
    history.authority("2"),
  );
  try {
    expect(
      await framework.objects.decryptObject(
        encrypted,
        context,
        await areaKey(rawKey),
        await history.signer(encrypted),
      ),
    ).toEqual(plaintext);
  } finally {
    rawKey.fill(0);
  }
  const previousRecovery = await recoveryIdentity(
    firstPhrase,
    context.tenant,
    "1",
  );
  const nextEnvelope = first.plan.domains[0]!.recoveryEnvelope;
  await expect(
    openBox(
      nextEnvelope,
      {
        tenant: context.tenant,
        purpose: "area-key",
        object: domain.definition.id,
        generation: "2",
        recipient: "recovery:2",
        author: "authority:2",
      },
      previousRecovery.encryptionKey.privateKey,
      history.authority("2"),
    ),
  ).rejects.toBeInstanceOf(InvalidProtectedData);

  expectedRecoveryKey = first.plan.nextSetup.authority.recoverySigningKey;
  const second = await framework.recovery.prepareRecovery({
    oldPhrase: secondPhrase,
    newPhrase: thirdPhrase,
    password,
    register,
    source: {
      challengeId: `challenge:${base64(randomSecret())}`,
      challenge: base64(randomSecret()),
      authority: first.plan.nextSetup.authority,
      catalog: first.plan.nextSetup.catalog,
      catalogVersion: "2",
      policyVersion: "2",
      domains: first.plan.domains.map(({ id, scope, facet, generation }) => ({
        id,
        scope,
        facet,
        generation,
      })),
      keys: first.plan.domains.map((definition) => definition.recoveryEnvelope),
      domainProofs: first.plan.domains,
    },
  });
  await framework.recovery.verifyRecoveryTransition(second.plan);
  expect(second.plan.nextSetup.owner.user).toBe("doctor:recovered-2");
  expect(
    second.plan.oldKeyEnvelopes.map((envelope) => envelope.generation).sort(),
  ).toEqual(["1", "2"]);
  expect(second.plan.domains[0]!.generation).toBe("3");
  for (const secret of [firstPhrase, secondPhrase, thirdPhrase, password]) {
    expect(transmitted.join("\n")).not.toContain(secret);
  }
}, 15_000);

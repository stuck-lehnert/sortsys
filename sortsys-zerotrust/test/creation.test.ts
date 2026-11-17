import { expect, test } from "bun:test";
import { allows, areaKey, base64, bytes, certifyCreationCapability, certifyIdentity, CREATION_FACETS, PROJECT_MODULE_FACETS, creationFacets, creationResource, createDelegatedDomain, createIdentity, createOrigin,
  creationRules, decryptObject, domainBoxSigner, encryptObject, importSigningKey, openBox, prepareRecovery, publicIdentity, verifyCreationOrigin, verifyDomain } from "../src/sortsys";
import { recoveryFixture } from "./support/recoveryFixture";

import { creationFixture } from "./support/creationFixture";

test("certified creation binds area, creator and mandatory readers without delegating the tenant key", async () => {
  const f = await creationFixture(), authority = () => f.authorityKey.publicKey;
  const verified = await verifyDomain(f.definition, { tenant: "test", id: f.definition.id, scope: f.definition.scope, facet: "master-data", generation: "1" }, authority);
  expect(verified.envelopes.map(box => box.recipient)).toEqual(["user:1", "user:2"]);
  const context = { tenant: "test", scope: f.definition.scope, facet: "master-data" as const, object: f.definition.scope, revision: "1", generation: "1", policyVersion: "1", author: "user:2" };
  const object = await encryptObject(context, bytes("private new project"), f.key, f.creator.signingKey.privateKey);
  for (const [subject, identity] of [["user:1", f.owner], ["user:2", f.creator]] as const) {
    const box = verified.envelopes.find(box => box.recipient === subject)!;
    const raw = await openBox(box, { tenant: "test", purpose: "area-key", object: verified.id, generation: "1", recipient: subject, author: box.author }, identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, authority));
    try { expect(new TextDecoder().decode(await decryptObject(object, context, await areaKey(raw), f.creator.signingKey.publicKey))).toBe("private new project"); }
    finally { raw.fill(0); }
  }
  const rules = creationRules(f.origin), permissions = { tenant: "test", version: "1", rules };
  const request = { tenant: "test", version: "1", subjects: ["user:2"], scope: "project:abc", facet: "master-data" as const, action: "read" as const };
  expect(allows(permissions, request)).toBe(true);
  expect(allows(permissions, { ...request, scope: "project:other" })).toBe(false);
  expect(allows(permissions, { ...request, facet: "calculation" })).toBe(false);
  expect(allows({ ...permissions, rules: [...rules, { ...rules[0]!, subject: "user:2", effect: "deny", actions: ["read"] }] }, request)).toBe(false);
});

test("creation rejects substituted identities, readers, namespaces and area bindings", async () => {
  const f = await creationFixture(), authority = () => f.authorityKey.publicKey;
  for (const mutate of [
    (origin: typeof f.origin) => { origin.scope = "project:def"; origin.id = "project:def:master-data"; },
    (origin: typeof f.origin) => { origin.capability.readers = []; },
    (origin: typeof f.origin) => { origin.capability.creator.user = "user:3"; },
    (origin: typeof f.origin) => { origin.capability.creator.signingKey = f.setup.owner.signingKey; },
    (origin: typeof f.origin) => { origin.facet = "calculation" as "master-data"; },
    (origin: typeof f.origin) => { origin.scope = "project:0abc"; origin.id = "project:0abc:master-data"; },
    (origin: typeof f.origin) => { origin.scope = "project:8000000000000"; origin.id = "project:8000000000000:master-data"; },
  ]) { const changed = structuredClone(f.origin); mutate(changed); await expect(verifyCreationOrigin(changed, authority)).rejects.toThrow(); }
  for (const changed of [{ ...f.definition, creation: undefined }, { ...f.definition, scope: "project:def" }, { ...f.definition, generation: "2" }])
    await expect(verifyDomain(changed, { tenant: "test", id: changed.id, scope: changed.scope, facet: "master-data", generation: changed.generation }, authority)).rejects.toThrow();
});

test("a project's attachment area has an independent facet-bound creation proof", async () => {
  const f = await creationFixture();
  const origin = await createOrigin({ ...f.origin, id: "project:abc:attachment", facet: "attachment" }, f.creator.signingKey.privateKey);
  const { definition } = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1",
    recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
  await verifyDomain(definition, { tenant: "test", id: "project:abc:attachment", scope: "project:abc", facet: "attachment", generation: "1" }, () => f.authorityKey.publicKey);
  await expect(verifyDomain({ ...definition, creation: f.origin }, { tenant: "test", id: "project:abc:attachment", scope: "project:abc", facet: "attachment", generation: "1" }, () => f.authorityKey.publicKey)).rejects.toThrow();
  expect(creationRules(origin).every(rule => rule.facet === "attachment")).toBe(true);
});

test("new project delivery quantities have their own creation proof and cannot use the procurement key", async () => {
  const f = await creationFixture(), scope = "project:abc:delivery-notes", facet = "master-data" as const;
  const origin = await createOrigin({ ...f.origin, id: `${scope}:${facet}`, scope, facet, parent: f.origin }, f.creator.signingKey.privateKey);
  const quantities = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1",
    recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
  await verifyDomain(quantities.definition, { tenant: "test", id: `${scope}:${facet}`, scope, facet, generation: "1" }, () => f.authorityKey.publicKey);
  const procurement = await createDelegatedDomain({ origin: await createOrigin({ ...f.origin, id: `${scope}:procurement`, scope, facet: "procurement", parent: f.origin }, f.creator.signingKey.privateKey),
    creatorKey: f.creator.signingKey.privateKey, policyVersion: "1", recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
  const context = { tenant: "test", scope, facet, object: "delivery-note:abc:1", generation: "1", revision: "1", policyVersion: "1", author: "user:2" };
  const value = await encryptObject(context, bytes("Liefermenge 2,375"), quantities.key, f.creator.signingKey.privateKey);
  await expect(decryptObject(value, context, procurement.key, f.creator.signingKey.publicKey)).rejects.toThrow();
  expect(creationRules(origin).every(rule => rule.facet === facet && rule.scope === scope)).toBe(true);
});

test("commercial creation is independent from project creation and each price or quantity facet has its own key", async () => {
  const f = await creationFixture("commercial"), authority = () => f.authorityKey.publicKey;
  const opened: { facet: string; key: CryptoKey }[] = [];
  for (const facet of CREATION_FACETS.commercial) {
    const id = `commercial:abc:${facet}`;
    const origin = await createOrigin({ ...f.origin, id, facet }, f.creator.signingKey.privateKey);
    const { definition, key } = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1",
      recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
    await verifyDomain(definition, { tenant: "test", id, scope: "commercial:abc", facet, generation: "1" }, authority);
    expect(creationRules(origin).every(rule => rule.scope === "commercial:abc" && rule.facet === facet)).toBe(true);
    opened.push({ facet, key });
  }
  const prices = opened.find(entry => entry.facet === "offer-prices")!;
  const context = { tenant: "test", scope: "commercial:abc", facet: "offer-prices" as const, object: "commercial:abc:offer", revision: "1", generation: "1", policyVersion: "1", author: "user:2" };
  const value = await encryptObject(context, bytes("592.00"), prices.key, f.creator.signingKey.privateKey);
  for (const other of opened.filter(entry => entry !== prices)) await expect(decryptObject(value, context, other.key, f.creator.signingKey.publicKey)).rejects.toThrow();
  for (const changed of [
    { ...f.origin, scope: "project:abc", id: "project:abc:master-data" },
    { ...f.origin, facet: "personnel" as const, id: "commercial:abc:personnel" },
    { ...f.origin, capability: { ...f.origin.capability, namespace: "project" as const } },
  ]) await expect(verifyCreationOrigin(changed, authority)).rejects.toThrow();
});

test("project modules bind their original parent and use independent content keys", async () => {
  const f = await creationFixture(), authority = () => f.authorityKey.publicKey, opened: { scope: string; facet: import("../src/sortsys").Facet; key: CryptoKey; definition: import("../src/sortsys").DomainDefinition }[] = [];
  for (const [module, facets] of Object.entries(PROJECT_MODULE_FACETS)) {
    const scope = `project:abc:${module}`;
    expect(creationResource(scope)).toEqual({ namespace: "project", id: "abc", module: module as import("../src/sortsys").ProjectModule });
    expect(creationFacets(scope)).toEqual(facets);
    for (const facet of facets) {
      const origin = await createOrigin({ ...f.origin, id: `${scope}:${facet}`, scope, facet, parent: f.origin }, f.creator.signingKey.privateKey);
      const created = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1", recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
      await verifyDomain(created.definition, { tenant: "test", id: `${scope}:${facet}`, scope, facet, generation: "1" }, authority);
      expect(creationRules(origin).every(rule => rule.scope === scope && rule.facet === facet)).toBe(true);
      expect(allows({ tenant: "test", version: "1", rules: creationRules(origin) }, { tenant: "test", version: "1", subjects: ["user:2"], scope: "project:abc", facet: "master-data", action: "read" })).toBe(false);
      opened.push({ ...created, scope, facet });
    }
  }
  for (const item of opened) {
    const context = { tenant: "test", scope: item.scope, facet: item.facet, object: "report:1", revision: "1", generation: "1", policyVersion: "1", author: "user:2" };
    const encrypted = await encryptObject(context, bytes("isolated report"), item.key, f.creator.signingKey.privateKey);
    for (const other of opened.filter(other => other !== item)) await expect(decryptObject(encrypted, context, other.key, f.creator.signingKey.publicKey)).rejects.toThrow();
    await expect(decryptObject(encrypted, context, f.key, f.creator.signingKey.publicKey)).rejects.toThrow();
  }
});

test("module proofs reject absent, substituted, nested, foreign-creator and foreign-generation parents", async () => {
  const f = await creationFixture(), authority = () => f.authorityKey.publicKey;
  const scope = "project:abc:daily-reports", input = { ...f.origin, id: `${scope}:master-data`, scope, parent: f.origin };
  const signed = await createOrigin(input, f.creator.signingKey.privateKey);
  await verifyCreationOrigin(signed, authority);
  for (const change of [
    { ...signed, parent: undefined }, { ...signed, parent: { ...f.origin, parent: f.origin } },
    { ...signed, parent: { ...f.origin, scope: "project:def", id: "project:def:master-data" } },
    { ...signed, parent: { ...f.origin, facet: "attachment", id: "project:abc:attachment" } },
    { ...signed, parent: { ...f.origin, capability: { ...f.origin.capability, generation: "2" } } },
    { ...signed, parent: { ...f.origin, capability: { ...f.origin.capability, creator: f.setup.owner } } },
    { ...signed, parent: { ...f.origin, signature: base64(new Uint8Array(64)) } },
    { ...signed, scope: "project:abc:regie-reports", id: "project:abc:regie-reports:master-data" },
    { ...f.origin, parent: f.origin },
  ]) await expect(verifyCreationOrigin(change, authority)).rejects.toThrow();
  for (const scope of ["project:abc:unknown", "project:abc:daily-reports:extra", "commercial:abc:daily-reports", "project:0abc:daily-reports"])
    expect(creationResource(scope)).toBeNull();
  for (const facet of ["personnel", "calculation", "contract-quantities"] as const)
    await expect(createOrigin({ ...f.origin, facet, id: `project:abc:${facet}` }, f.creator.signingKey.privateKey)).rejects.toThrow();
});

test("tool and tracking creation cannot grant project access, other records or unrelated facets", async () => {
  for (const namespace of ["tool", "tool-tracking"] as const) {
    const f = await creationFixture(namespace), authority = () => f.authorityKey.publicKey;
    for (const facet of CREATION_FACETS[namespace]) {
      const scope = `${namespace}:abc`, origin = await createOrigin({ ...f.origin, id: `${scope}:${facet}`, facet }, f.creator.signingKey.privateKey);
      const created = await createDelegatedDomain({ origin, creatorKey: f.creator.signingKey.privateKey, policyVersion: "1", recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey } });
      await verifyDomain(created.definition, { tenant: "test", id: `${scope}:${facet}`, scope, facet, generation: "1" }, authority);
      expect(creationRules(origin).every(rule => rule.scope === scope && rule.facet === facet)).toBe(true);
    }
    for (const changed of [
      { ...f.origin, scope: "project:abc", id: "project:abc:master-data" },
      { ...f.origin, scope: `${namespace}:def`, id: `${namespace}:def:master-data` },
      { ...f.origin, facet: "personnel" as const, id: `${namespace}:abc:personnel` },
      { ...f.origin, capability: { ...f.origin.capability, namespace: "project" as const } },
    ]) await expect(verifyCreationOrigin(changed, authority)).rejects.toThrow();
  }
});

for (const namespace of [
  "project",
  "commercial",
  "tool",
  "tool-tracking",
] as const)
  test(`phrase-only recovery opens ${namespace} creator keys and rejects unproven creator packages`, async () => {
    const fixture = await recoveryFixture();
    const creator = await createIdentity();
    const member = await certifyIdentity(
      {
        tenant: "test",
        generation: "1",
        user: "user:2",
        ...(await publicIdentity(creator)),
      },
      fixture.authorityKey.privateKey,
    );
    const capability = await certifyCreationCapability(
      {
        tenant: "test",
        generation: "1",
        id: "create_test",
        namespace,
        creator: member,
        readers: [fixture.setup.owner],
      },
      fixture.authorityKey.privateKey,
    );
    const origin = await createOrigin(
      {
        tenant: "test",
        id: `${namespace}:abc:master-data`,
        scope: `${namespace}:abc`,
        facet: "master-data",
        capability,
      },
      creator.signingKey.privateKey,
    );
    const { definition, key } = await createDelegatedDomain({
      origin,
      creatorKey: creator.signingKey.privateKey,
      policyVersion: "1",
      recovery: {
        encryptionKey: fixture.setup.authority.recoveryEncryptionKey,
        signingKey: fixture.setup.authority.recoverySigningKey,
      },
    });
    const definitions = [definition];
    if (namespace === "project") {
      for (const [module, facets] of Object.entries(PROJECT_MODULE_FACETS)) {
        for (const facet of facets) {
          const scope = `project:abc:${module}`;
          const part = await createOrigin(
            {
              ...origin,
              id: `${scope}:${facet}`,
              scope,
              facet,
              parent: origin,
            },
            creator.signingKey.privateKey,
          );
          const created = await createDelegatedDomain({
            origin: part,
            creatorKey: creator.signingKey.privateKey,
            policyVersion: "1",
            recovery: {
              encryptionKey: fixture.setup.authority.recoveryEncryptionKey,
              signingKey: fixture.setup.authority.recoverySigningKey,
            },
          });
          definitions.push(created.definition);
        }
      }
    }
    const source = {
      ...fixture.source,
      domains: [
        ...fixture.source.domains,
        ...definitions.map((part) => ({
          id: part.id,
          scope: part.scope,
          facet: part.facet,
          generation: "1",
        })),
      ],
      keys: [
        ...fixture.source.keys,
        ...definitions.map((part) => part.recoveryEnvelope),
      ],
      domainProofs: [...fixture.source.domainProofs, ...definitions],
    };
    const { plan, identity } = await prepareRecovery({
      oldPhrase: fixture.phrase,
      newPhrase: fixture.newPhrase,
      password: fixture.password,
      source,
      register: fixture.register,
    });
    for (const part of definitions)
      expect(plan.oldKeyEnvelopes.some((box) => box.object === part.id)).toBe(
        true,
      );
    const archived = plan.oldKeyEnvelopes.find(
      (box) => box.object === definition.id,
    )!;
    const raw = await openBox(
      archived,
      {
        tenant: "test",
        purpose: "area-key",
        object: definition.id,
        generation: "1",
        recipient: plan.transition.nextAdministrator,
        author: "authority:2",
      },
      identity.encryptionKey.privateKey,
      await importSigningKey(plan.nextSetup.authority.authoritySigningKey),
    );
    const context = {
      tenant: "test",
      scope: definition.scope,
      facet: "master-data" as const,
      object: definition.scope,
      revision: "1",
      generation: "1",
      policyVersion: "1",
      author: "user:2",
    };
    try {
      const encrypted = await encryptObject(
        context,
        bytes("created before recovery"),
        key,
        creator.signingKey.privateKey,
      );
      const plaintext = await decryptObject(
        encrypted,
        context,
        await areaKey(raw),
        creator.signingKey.publicKey,
      );
      expect(new TextDecoder().decode(plaintext)).toBe("created before recovery");
    } finally {
      raw.fill(0);
    }
    let registered = false;
    const register = async () => {
      registered = true;
      throw new Error("not reached");
    };
    await expect(
      prepareRecovery({
        oldPhrase: fixture.phrase,
        newPhrase: fixture.newPhrase,
        password: fixture.password,
        source: { ...source, domainProofs: [] },
        register,
      }),
    ).rejects.toThrow();
    const replaced = structuredClone(definition);
    replaced.creation!.capability.creator.signingKey = base64(
      new Uint8Array(32),
    );
    await expect(
      prepareRecovery({
        oldPhrase: fixture.phrase,
        newPhrase: fixture.newPhrase,
        password: fixture.password,
        source: { ...source, domainProofs: [replaced] },
        register,
      }),
    ).rejects.toThrow();
    expect(registered).toBe(false);
  }, 15000);

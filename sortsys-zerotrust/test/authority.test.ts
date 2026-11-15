import { expect, test } from "bun:test";
import { areaKey, base64, createDomain, createIdentity, createRecoveryPhrase, createTenantSetup, domainFrame, importSigningKey, openBox, publicIdentity, sign, signPolicy, signingPair, tenantSetupFrame, verify, verifyAuthority, verifyDomain, verifyPolicy, verifyTenantSetup } from "../src/sortsys";

test("policy suspension cannot be stripped, changed or introduced without a new authority signature", async () => {
  const authority = await signingPair(), expected = { tenant: "test", authority: authority.publicKey };
  const signed = await signPolicy({ tenant: "test", version: "8", rules: [], suspended: ["user:1"] }, authority.privateKey);
  expect((await verifyPolicy(signed, expected)).permissions.suspended).toEqual(["user:1"]);
  const { suspended, ...stripped } = signed;
  await expect(verifyPolicy(stripped, expected)).rejects.toThrow();
  await expect(verifyPolicy({ ...signed, suspended: [] }, expected)).rejects.toThrow();
  const original = await signPolicy({ tenant: "test", version: "9", rules: [] }, authority.privateKey);
  await expect(verifyPolicy({ ...original, suspended: [] }, expected)).rejects.toThrow();
});

test("policy verification binds an exact schema and tenant to the pinned authority", async () => {
  const authority = await signingPair(), other = await signingPair();
  const permissions = { tenant: "test", version: "7", rules: [{ subject: "user:1", scope: "project:123", facet: "measurement" as const, effect: "allow" as const, actions: ["read" as const] }] };
  const signed = await signPolicy(permissions, authority.privateKey), expected = { tenant: "test", authority: authority.publicKey };
  expect(await verifyPolicy(signed, expected)).toEqual({ permissions, signature: signed.signature });
  const foreign = await signPolicy({ ...permissions, tenant: "other" }, authority.privateKey);
  for (const candidate of [foreign, { ...signed, version: "8" }, { ...signed, rules: [] }, { ...signed, extra: true }, { ...signed, signature: null },
    await signPolicy(permissions, other.privateKey)]) await expect(verifyPolicy(candidate, expected)).rejects.toThrow();
  await expect(verifyPolicy(signed, { ...expected, authority: other.publicKey })).rejects.toThrow();
});

test("a database-supplied recovery or authority replacement cannot bypass a pinned recovery root", async () => {
  const owner = await createIdentity();
  const { setup } = await createTenantSetup("test", "user:1", owner, createRecoveryPhrase());
  const pinned = { tenant: "test", generation: "1", recoverySigningKey: setup.authority.recoverySigningKey };
  expect(await verifyAuthority(setup.authority, pinned)).toEqual(setup.authority);
  const attacker = await createIdentity();
  const attackerKeys = await publicIdentity(attacker);
  await expect(verifyAuthority({ ...setup.authority, authoritySigningKey: attackerKeys.signingKey }, pinned)).rejects.toThrow();
  await expect(verifyAuthority({ ...setup.authority, recoverySigningKey: attackerKeys.signingKey }, pinned)).rejects.toThrow();
  await verify(owner.signingKey.publicKey, setup.proof, await tenantSetupFrame(setup));
  const changed = { ...setup, owner: { ...setup.owner, user: "user:2" } };
  await expect(verify(owner.signingKey.publicKey, changed.proof, await tenantSetupFrame(changed))).rejects.toThrow();
});

test("the setup decoder binds owner, policy, authority envelope and recovery catalog to the pinned root", async () => {
  const identity = await createIdentity();
  const { setup } = await createTenantSetup("test", "user:1", identity, createRecoveryPhrase());
  const pinned = { tenant: "test", generation: "1", recoverySigningKey: setup.authority.recoverySigningKey };
  expect(await verifyTenantSetup(setup, pinned)).toEqual(setup);
  const changes = [
    { ...setup, extra: "unknown" },
    { ...setup, owner: { ...setup.owner, user: "user:2" } },
    { ...setup, policy: { ...setup.policy, rules: [] } },
    { ...setup, catalog: { ...setup.catalog, purpose: "area-key" } },
    { ...setup, authorityEnvelope: { ...setup.authorityEnvelope, recipient: "user:2" } },
    { ...setup, proof: base64(new Uint8Array(64)) },
  ];
  for (const changed of changes) await expect(verifyTenantSetup(changed, pinned)).rejects.toThrow();
});

test("a domain distributes one key to authorized readers, and the root signs every individual envelope", async () => {
  const authority = await signingPair();
  const first = await createIdentity();
  const second = await createIdentity();
  const recovery = await createIdentity();
  const made = await createDomain({ tenant: "test", id: "domain:1", scope: "project:123", facet: "measurement", generation: "1", policyVersion: "1", authorityGeneration: "1", authorityKey: authority.privateKey, recovery: await publicIdentity(recovery), readers: [{ subject: "user:1", identity: await publicIdentity(first) }, { subject: "user:2", identity: await publicIdentity(second) }] });
  await verify(authority.publicKey, made.definition.proof, await domainFrame(made.definition));
  for (const [index, identity] of [first, second].entries()) {
    const envelope = made.definition.envelopes[index]!;
    const { format: _format, enc: _enc, ciphertext: _ciphertext, signature: _signature, ...context } = envelope;
    const raw = await openBox(envelope, context, identity.encryptionKey.privateKey, authority.publicKey);
    expect(base64(raw)).toBe(base64(await crypto.subtle.exportKey("raw", made.key)));
    expect(await crypto.subtle.exportKey("raw", await areaKey(raw))).toEqual(await crypto.subtle.exportKey("raw", made.key));
  }
  const changed = { ...made.definition, envelopes: made.definition.envelopes.slice(1) };
  await expect(verify(authority.publicKey, made.definition.proof, await domainFrame(changed))).rejects.toThrow();
  const other = await publicIdentity(await createIdentity());
  await expect(verify(await importSigningKey(other.signingKey), made.definition.proof, await domainFrame(made.definition))).rejects.toThrow();
});

test("removing every ordinary reader still leaves a recoverable fresh domain generation", async () => {
  const authority = await signingPair(), recovery = await createIdentity();
  const { definition, key } = await createDomain({ tenant: "test", id: "domain:private", scope: "assistant:user:1", facet: "master-data",
    generation: "2", policyVersion: "3", authorityGeneration: "1", authorityKey: authority.privateKey, recovery: await publicIdentity(recovery), readers: [] });
  expect(definition.envelopes).toEqual([]);
  await verifyDomain(definition, { tenant: "test", id: definition.id, scope: definition.scope, facet: definition.facet, generation: "2" }, () => authority.publicKey);
  const box = definition.recoveryEnvelope;
  const raw = await openBox(box, { tenant: "test", purpose: "area-key", object: definition.id, generation: "2", recipient: "recovery:1", author: "authority:1" }, recovery.encryptionKey.privateKey, authority.publicKey);
  expect(base64(raw)).toBe(base64(await crypto.subtle.exportKey("raw", key))); raw.fill(0);
});

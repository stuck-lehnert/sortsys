import { expect, test } from "bun:test";
import { recoveryFixture } from "./support/recoveryFixture";
import { areaKey, base64, bytes, createDomain, createRecoveryPhrase, decryptObject, encryptObject, finishOpaqueLogin, importSigningKey, opaqueIdentifiers, openAccountVault, openBox, prepareRecovery, publicIdentity, randomSecret, recoveryBundleHash, recoveryIdentity, startOpaqueLogin, utf8, verifyRecoveryTransition, verifyTrustHistory } from "../src";
import { server } from "@serenity-kit/opaque";

test("seed recovery restores historical content, changes all future keys and creates an independent OPAQUE account", async () => {
  const f = await recoveryFixture();
  await verifyRecoveryTransition(f.plan);
  const context = { tenant: "test", scope: "tenant:test", facet: "calculation" as const, object: "position:1", revision: "1", generation: "1", policyVersion: "1", author: "user:interop" };
  const encrypted = await encryptObject(context, bytes("confidential calculation"), f.key, f.owner.signingKey.privateKey);
  const authority = await importSigningKey(f.plan.nextSetup.authority.authoritySigningKey);
  const archived = f.plan.oldKeyEnvelopes[0]!;
  const oldKey = await openBox(archived, { tenant: "test", purpose: "area-key", object: archived.object, generation: "1", recipient: f.plan.transition.nextAdministrator, author: "authority:2" }, f.identity.encryptionKey.privateKey, authority);
  expect(utf8(await decryptObject(encrypted, context, await areaKey(oldKey), f.owner.signingKey.publicKey))).toBe("confidential calculation");
  const next = f.plan.domains[0]!.envelopes[0]!;
  const newKey = await openBox(next, { tenant: "test", purpose: "area-key", object: next.object, generation: "2", recipient: f.plan.transition.nextAdministrator, author: "authority:2" }, f.identity.encryptionKey.privateKey, authority);
  expect(base64(newKey)).not.toBe(base64(oldKey));
  const oldRecovery = await recoveryIdentity(f.phrase, "test", "1");
  const recoveryBox = f.plan.domains[0]!.recoveryEnvelope;
  await expect(openBox(recoveryBox, { tenant: "test", purpose: "area-key", object: recoveryBox.object, generation: "2", recipient: "recovery:2", author: "authority:2" }, oldRecovery.encryptionKey.privateKey, authority)).rejects.toThrow();
  const started = await startOpaqueLogin(f.password);
  const response = server.startLogin({ serverSetup: f.serverSetup, registrationRecord: f.plan.registrationRecord, userIdentifier: `test/${f.plan.username}`, startLoginRequest: started.startLoginRequest, identifiers: opaqueIdentifiers("test", f.plan.username) });
  const login = await finishOpaqueLogin(f.password, "test", f.plan.username, started, response.loginResponse);
  const opened = await openAccountVault(login.exportKey, "test", f.plan.username, f.plan.vault);
  expect(await publicIdentity(opened.identity)).toEqual(await publicIdentity(f.identity));
  expect(opened.pins.recoverySigningKey).toBe(f.plan.nextSetup.authority.recoverySigningKey);
  const wire = JSON.stringify(f.plan);
  for (const secret of [f.phrase, f.newPhrase, f.password, base64(oldKey), base64(newKey)]) expect(wire).not.toContain(secret);
}, 15000);

test("recovery signatures bind account, root, catalog, archived keys and newly distributed domain keys", async () => {
  const { plan } = await recoveryFixture();
  for (const change of [
    (p: typeof plan) => { p.username = "recovery-other"; },
    (p: typeof plan) => { p.oldKeyEnvelopes = []; },
    (p: typeof plan) => { p.domains = []; },
    (p: typeof plan) => { p.transition.catalogVersion = "3"; },
    (p: typeof plan) => { p.vault.wrappedKey = plan.vault.wrappedKey.split("").reverse().join(""); },
    (p: typeof plan) => { p.sourceAuthority.authoritySigningKey = plan.transition.nextAuthoritySigningKey; },
  ]) {
    const changed = structuredClone(plan); change(changed);
    await expect(verifyRecoveryTransition(changed)).rejects.toThrow();
  }
  expect(await recoveryBundleHash(plan)).toBe(plan.transition.nextAdministratorBundleHash);
}, 15000);

test("a missing current recovery key or reuse of the old phrase stops before any registration request", async () => {
  const f = await recoveryFixture();
  let calls = 0;
  const register = async () => { calls++; throw new Error("must not be called"); };
  await expect(prepareRecovery({ oldPhrase: f.phrase, newPhrase: f.newPhrase, password: f.password, source: { ...f.source, keys: [] }, register })).rejects.toThrow();
  await expect(prepareRecovery({ oldPhrase: f.phrase, newPhrase: f.phrase, password: f.password, source: f.source, register })).rejects.toThrow();
  expect(calls).toBe(0);
}, 15000);

test("a second recovery preserves both historical key generations and verifies old authors from the new pinned root", async () => {
  const f = await recoveryFixture();
  const { plan: second } = await prepareRecovery({ oldPhrase: f.newPhrase, newPhrase: createRecoveryPhrase(), password: f.password, register: f.register, source: {
    challengeId: `zt_${base64(randomSecret())}`, challenge: base64(randomSecret()),
    authority: f.plan.nextSetup.authority, catalog: f.plan.nextSetup.catalog, catalogVersion: "3", policyVersion: "2",
    domains: f.plan.domains.map(d => ({ id: d.id, scope: d.scope, facet: d.facet, generation: d.generation })),
    keys: f.plan.domains.map(d => d.recoveryEnvelope), createdDomains: [],
  } });
  expect(second.oldKeyEnvelopes.map(e => e.generation).sort()).toEqual(["1", "2"]);
  expect(second.domains[0]!.generation).toBe("3");
  await verifyRecoveryTransition(second);
  const link = (p: typeof second) => ({ sourceAuthority: p.sourceAuthority, transition: p.transition, proof: p.proof, nextProof: p.nextProof });
  const history = { authorities: [
    { certificate: f.setup.authority, transition: null },
    { certificate: f.plan.nextSetup.authority, transition: link(f.plan) },
    { certificate: second.nextSetup.authority, transition: link(second) },
  ], identities: [f.setup.owner, f.plan.nextSetup.owner, second.nextSetup.owner] };
  const pinned = { tenant: "test", generation: "3", recoverySigningKey: second.transition.nextRecoverySigningKey };
  const trust = await verifyTrustHistory(history, pinned);
  const context = { tenant: "test", scope: "tenant:test", facet: "calculation" as const, object: "position:1", revision: "1", generation: "1", policyVersion: "1", author: f.setup.owner.user };
  const encrypted = await encryptObject(context, bytes("original"), f.key, f.owner.signingKey.privateKey);
  expect(utf8(await decryptObject(encrypted, context, f.key, await trust.signer(encrypted)))).toBe("original");
  expect(trust.current.generation).toBe("3");
  await expect(verifyTrustHistory({ ...history, authorities: history.authorities.slice(0, 2) }, pinned)).rejects.toThrow();
  const replaced = structuredClone(history);
  replaced.authorities[0]!.certificate.authoritySigningKey = second.transition.nextAuthoritySigningKey;
  await expect(verifyTrustHistory(replaced, pinned)).rejects.toThrow();
  const forgedAuthor = { ...f.setup.owner, signingKey: second.nextSetup.owner.signingKey };
  await expect(verifyTrustHistory({ ...history, identities: [forgedAuthor] }, pinned)).rejects.toThrow();
}, 15000);

test("recovery ignores unpublished domain drafts and conflicting future key drafts", async () => {
  const f = await recoveryFixture();
  const draft = (id: string, generation: string) => createDomain({ tenant: "test", id, scope: "tenant:test", facet: "calculation",
    generation, policyVersion: "1", authorityGeneration: "1", authorityKey: f.authorityKey.privateKey,
    recovery: { encryptionKey: f.setup.authority.recoveryEncryptionKey, signingKey: f.setup.authority.recoverySigningKey },
    readers: [{ subject: f.setup.owner.user, identity: f.setup.owner }] });
  const drafts = await Promise.all([draft("domain:unpublished", "1"), draft(f.definition.id, "2"), draft(f.definition.id, "2")]);
  const { plan } = await prepareRecovery({ oldPhrase: f.phrase, newPhrase: f.newPhrase, password: f.password, register: f.register,
    source: { ...f.source, keys: [...f.source.keys, ...drafts.map(value => value.definition.recoveryEnvelope)] } });
  expect(plan.oldKeyEnvelopes.map(value => [value.object, value.generation])).toEqual([[f.definition.id, "1"]]);
  expect(plan.domains.map(value => [value.id, value.generation])).toEqual([[f.definition.id, "2"]]);
  await verifyRecoveryTransition(plan);
}, 15000);

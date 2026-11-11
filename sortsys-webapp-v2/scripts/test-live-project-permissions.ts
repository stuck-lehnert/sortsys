import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { areaKey, decryptObject, openBox } from "@sortsys/zerotrust";
import { acceptVault, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeMemberAccess, changeProjectAccess, changeProjectCreation, memberProjectAccess, memberProjectCreation } from "../app/lib/crypto/permissions";
import { testFilePermissions, denyUnownedFileArea } from "./test-live-file-permissions";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import type { DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { projectCollection, type ProjectPayload } from "../app/lib/data/projectData";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import { testCommercialPermissions } from "./test-live-commercial-permissions";
import { testProjectCommercialPermissions } from "./test-live-project-commercial-permissions";

export async function testProjectPermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount,
  driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const memberId = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id, user = `user:${memberId}`;
  const root = createBusinessClient(ownerClient, { productDriver: driver });
  const projectA = (await required(root.query("projects.list", {})))[0]!, projectB = (await required(root.query("projects.list", {})))[1]!;
  const master = projectCollection(projectA.id), hidden = { ...master, domain: `${master.scope}:calculation`, facet: "calculation" as const, prefix: `calculation:${projectA.id}` };
  const ownerId = (await required(ownerClient.query("auth.sessionInfo", undefined))).user.id;
  await provisionOwnedCollections(ownerClient, `user:${ownerId}`, [hidden], signal);
  const calculation = await protectedCollection(ownerClient, hidden, signal);
  let calculationPacket;
  try {
    await calculation.read(); calculationPacket = await calculation.packet(hidden.prefix, { format: "sortsys-test-calculation-v1", cost: "12345.67", label: "Geheime Projektkalkulation" });
    await calculation.write([calculationPacket]);
  } finally { calculation.close(); }
  await changeMemberAccess(ownerClient, user, { catalogue: "write", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true }, signal);
  await changeProjectAccess(ownerClient, user, projectA.id, "read", signal);
  assert.deepEqual(await memberProjectAccess(ownerClient, user, signal), { [projectA.id]: "read" });
  await acceptVault(member.exportKey, member.vault, false);
  const keys: string[] = [], observed: Client = { ...memberClient, query: ((path, input, options) => {
    if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain); return memberClient.query(path, input, options);
  }) as Client["query"] };
  let business = createBusinessClient(observed, { productDriver: driver });
  let previousKey: CryptoKey;
  try {
    assert.deepEqual((await required(business.query("projects.list", {}))).map(project => project.id), [projectA.id]);
    assert.ok((await business.query("projects.get", { id: projectB.id }))[1]);
    assert.ok((await business.mutate("projects.update", { id: projectA.id, data: { title: "Denied project update" } }))[1]);
    assert.ok((await business.mutate("projects.finish", { id: projectA.id }))[1]);
    assert.ok((await business.mutate("projects.create", { title: "No tenant authority delegation" }))[1]);
    assert.equal(keys.some(key => key !== master.domain), false);
    assert.ok((await memberClient.query("zerotrust.keys.get", { domain: hidden.domain, generation: "1" }, { strategy: "network-only" }))[1]);
    const history = await trustedHistory(memberClient), domain = (await required(memberClient.query("zerotrust.domains.list", undefined))).find(domain => domain.id === master.domain)!;
    const box = await required(memberClient.query("zerotrust.keys.get", { domain: master.domain, generation: domain.generation }, { strategy: "network-only" }));
    const raw = await openBox(box, { tenant: member.tenant, purpose: "area-key", object: master.domain, generation: domain.generation,
      recipient: user, author: box.author }, member.identity.encryptionKey.privateKey, history.authority(box.author.split(":")[1]!));
    try { previousKey = await areaKey(raw); } finally { raw.fill(0); }
    const { format: _format, nonce: _nonce, ciphertext: _ciphertext, wrappedKey: _wrapped, signature: _sig, ...context } = calculationPacket.envelope;
    await assert.rejects(() => decryptObject(calculationPacket.envelope, context, previousKey, owner.identity.signingKey.publicKey),
      "The project's master-data key cannot decrypt its calculation, even if its ciphertext is supplied");
  } finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, projectA.id, "write", signal);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    await required(business.mutate("projects.update", { id: projectA.id, data: { title: "Gezielt freigegebenes Projekt bearbeitet" } }));
    await required(business.mutate("projects.contacts.set", { projectId: projectA.id, contacts: [] }));
    assert.ok((await business.query("contacts.list", {}))[1], "Project editing and clearing links do not require decrypting all contacts");
    assert.ok((await business.mutate("projects.update", { id: projectB.id, data: { title: "Denied other project" } }))[1]);
  } finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, projectA.id, "none", signal);
  const canary = "Projektinhalt nach Entzug der Projektfreigabe";
  await required(root.mutate("projects.update", { id: projectA.id, data: { title: canary } }));
  const current = await protectedCollection(ownerClient, master, signal);
  try {
    const changed = (await current.read())[0]!, value = changed.value as ProjectPayload;
    assert.equal(value.project!.values.title, canary);
    const { format: _format, nonce: _nonce, ciphertext: _ciphertext, wrappedKey: _wrapped, signature: _sig, ...context } = changed.envelope;
    await assert.rejects(() => decryptObject(changed.envelope, context, previousKey, owner.identity.signingKey.publicKey));
  } finally { current.close(); }
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try { assert.deepEqual(await required(business.query("projects.list", {})), []); }
  finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, projectA.id, "read", signal);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try { assert.equal((await required(business.query("projects.get", { id: projectA.id }))).title, canary); }
  finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectCreation(ownerClient, user, true, signal);
  assert.equal(await memberProjectCreation(ownerClient, user, signal), true);
  await acceptVault(member.exportKey, member.vault, false);
  let created;
  business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    await denyUnownedFileArea(memberClient, signal);
    created = await required(business.mutate("projects.create", { title: "Vom Mitarbeiter verschlüsselt angelegtes Projekt", responsibleProjectLeaderUserId: ownerId }));
    assert.equal((await required(business.query("projects.get", { id: created.id }))).title, "Vom Mitarbeiter verschlüsselt angelegtes Projekt");
    assert.ok((await business.query("projects.get", { id: projectB.id }))[1]);
    const definition = await required(memberClient.query("zerotrust.domains.get", { domain: projectCollection(created.id).domain, generation: "1" }, { strategy: "network-only" }));
    assert.equal(definition.creation?.capability.creator.user, user);
    assert.deepEqual(definition.envelopes.map(box => box.recipient).sort(), [user, `user:${ownerId}`].sort());
    const quantities = await required(memberClient.query("zerotrust.domains.get", { domain: deliveryCollection(created.id).domain, generation: "1" }, { strategy: "network-only" }));
    assert.equal(quantities.creation?.facet, "contract-quantities");
    assert.equal(quantities.creation?.capability.creator.user, user);
    assert.deepEqual(quantities.envelopes.map(box => box.recipient).sort(), [user, `user:${ownerId}`].sort());
    assert.ok((await memberClient.mutate("zerotrust.policy.replace", { tenant: owner.tenant, version: "999999", rules: [], signature: definition.proof }))[1]);
  } finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await root.invalidate("projects.list");
  assert.equal((await required(root.query("projects.get", { id: created.id }))).title, "Vom Mitarbeiter verschlüsselt angelegtes Projekt", "The mandatory administrator can read creator-published areas");
  assert.equal((await memberProjectAccess(ownerClient, user, signal))[created.id], "write");
  await changeProjectCreation(ownerClient, user, false, signal);
  assert.equal(await memberProjectCreation(ownerClient, user, signal), false);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    assert.ok((await business.mutate("projects.create", { title: "No longer allowed to create" }))[1]);
    await required(business.mutate("projects.update", { id: created.id, data: { title: "Bestehendes Projekt bleibt bearbeitbar" } }));
  } finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, created.id, "read", signal);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    assert.equal((await required(business.query("projects.get", { id: created.id }))).title, "Bestehendes Projekt bleibt bearbeitbar");
    assert.ok((await business.mutate("projects.update", { id: created.id, data: { title: "Creator denied by explicit root policy" } }))[1]);
  } finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, created.id, "none", signal);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try { assert.ok((await business.query("projects.get", { id: created.id }))[1]); }
  finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await changeProjectAccess(ownerClient, user, created.id, "read", signal);
  await acceptVault(member.exportKey, member.vault, false); business = createBusinessClient(memberClient, { productDriver: driver });
  try { assert.equal((await required(business.query("projects.get", { id: created.id }))).title, "Bestehendes Projekt bleibt bearbeitbar"); }
  finally { business.dispose(); root.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  await testProjectCommercialPermissions(ownerClient, memberClient, owner, member, projectA.id, signal);
  await testFilePermissions(ownerClient, memberClient, owner, member, driver, signal, projectA.id);
  await testCommercialPermissions(ownerClient, memberClient, owner, member, driver, signal);
  console.log("Per-project grants and delegated creation verified: mandatory readers, isolated scopes/facets, creation revocation without losing existing areas, explicit denials overriding creator rights, rotation and historical regrant.");
  return canary;
}

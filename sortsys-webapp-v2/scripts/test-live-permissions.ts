import assert from "node:assert/strict";
import { SQL } from "bun";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { areaKey, decryptObject, openBox } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, trustedHistory } from "../app/lib/crypto/session";
import type { UnlockedAccount } from "../app/lib/crypto/session";
import { changeMemberAccess, finishAccessChanges, memberAccess } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openProtectedProducts, PRODUCT_COLLECTION } from "../app/lib/data/products";
import type { ProductPayload } from "../app/lib/data/products";
import { newAssistantId, privateLlmCollection } from "../app/lib/data/privateLlm";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { watchEncryptedEvents, type EncryptedChange } from "../app/lib/data/events";
import { until } from "./test-live-events";
import type { DuckDriver } from "../app/lib/data/database";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION, type AddressPayload } from "../app/lib/data/addressBook";
import { testProjectPermissions } from "./test-live-project-permissions";

export async function testPolicyWriteConfirmation(ownerClient: Client, subject: string, signal: AbortSignal) {
  const previous = await memberAccess(ownerClient, subject, signal); assert.ok(previous);
  const original = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
  const domains = await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }));
  let discarded = 0, rotations = 0;
  const falseAcknowledgement: Client = { ...ownerClient, mutate: ((path, input, options) => {
    if (path === "zerotrust.policy.replace") { discarded++; return Promise.resolve([{ success: true }, null]); }
    if (path === "zerotrust.domains.put") rotations++;
    return ownerClient.mutate(path, input, options);
  }) as Client["mutate"] };
  const requested = { ...previous, catalogue: previous.catalogue === "none" ? "read" as const : "none" as const };
  await assert.rejects(() => changeMemberAccess(falseAcknowledgement, subject, requested, signal), "A fabricated success cannot acknowledge a grant or revocation");
  assert.equal(discarded, 1); assert.equal(rotations, 0);
  assert.equal((await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }))).signature, original.signature);
  assert.deepEqual(await memberAccess(ownerClient, subject, signal), previous);
  assert.deepEqual(await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" })), domains);

  let lost = false;
  const lostAcknowledgement: Client = { ...ownerClient, mutate: (async (path, input, options) => {
    const result = await ownerClient.mutate(path, input, options);
    if (path === "zerotrust.policy.replace" && !result[1] && !lost) { lost = true; return [null, new Error("Synthetic lost policy reply")]; }
    return result;
  }) as Client["mutate"] };
  try {
    const changed = { ...previous, catalogue: previous.catalogue === "write" ? "read" as const : "write" as const };
    await changeMemberAccess(lostAcknowledgement, subject, changed, signal); assert.equal(lost, true);
    assert.deepEqual(await memberAccess(ownerClient, subject, signal), changed);
  } finally { await changeMemberAccess(ownerClient, subject, previous, signal); }
  console.log("Policy publication verified: a false success changes neither grants nor key generations; an actually committed replacement survives a lost reply.");
}

export async function testLiveAccessChanges(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount,
  driver: () => Promise<DuckDriver>, signal: AbortSignal): Promise<string> {
  const session = await required(memberClient.query("auth.sessionInfo", undefined, { strategy: "network-only" })), subject = `user:${session.user.id}`;
  const personal = privateLlmCollection(subject), canary = "Neuer Katalogstand nach dem Entzug des Lesezugriffs";
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const trust = await trustedHistory(memberClient);
  const before = (await required(memberClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).find(domain => domain.id === PRODUCT_COLLECTION.domain)!;
  const box = await required(memberClient.query("zerotrust.keys.get", { domain: before.id, generation: before.generation }, { strategy: "network-only" }));
  const raw = await openBox(box, { tenant: member.tenant, purpose: "area-key", object: before.id, generation: before.generation,
    recipient: subject, author: box.author }, member.identity.encryptionKey.privateKey, trust.authority(box.author.split(":")[1]!));
  const oldKey = await areaKey(raw); raw.fill(0);
  await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const ownerSession = await required(ownerClient.query("auth.sessionInfo", undefined, { strategy: "network-only" }));
  const ownerArea = privateLlmCollection(`user:${ownerSession.user.id}`), own = await protectedCollection(ownerClient, ownerArea, signal);
  let privatePacket: MutateInput<"zerotrust.objects.save">, privateHead: string;
  const privateCanary = "Privater Verlauf darf keine Ereignisse an andere Benutzer verraten";
  try {
    await own.read(); const id = newAssistantId();
    privatePacket = await own.packet(`assistant:chat:${id}`, { format: "sortsys-assistant-v1", kind: "chat", id, value: { text: privateCanary } });
    privateHead = own.snapshot();
  } finally { own.close(); }
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const control = new AbortController(), hints: EncryptedChange[] = [];
  const observer = watchEncryptedEvents(memberClient, process.env.SORTSYS_LLM_TEST_PEER!, event => hints.push(event), control.signal);
  const dsn = process.env.SORTSYS_MIGRATION_TEST_PG_DSN;
  if (!dsn || process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1" || !new URL(dsn).hostname.startsWith("sortsys-test-api-postgres-")) throw new Error("Disposable privacy fixture required");
  const pg = new SQL(dsn);
  try {
    await until(() => hints.some(event => event.all && event.control), "member event connection");
    await required(ownerClient.mutate("zerotrust.objects.batch", { objects: [privatePacket], heads: [{ domain: ownerArea.domain, sequence: privateHead }] }));
    // A permitted positive control follows the real private commit on the same
    // PG channel, proving that the decoder has processed past the private hint.
    await pg`SELECT pg_notify('sortsys_zerotrust',${JSON.stringify({ kind: "object", domain: PRODUCT_COLLECTION.domain, seq: "1" })}::text)`;
    await until(() => hints.some(event => Object.hasOwn(event.domains, PRODUCT_COLLECTION.domain)), "permitted event control");
    assert.equal(hints.some(event => Object.hasOwn(event.domains, ownerArea.domain)), false);
    assert.equal(JSON.stringify(hints).includes(privateCanary), false);
  } finally { control.abort(); await observer; await pg.close(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  assert.deepEqual(await memberAccess(ownerClient, subject, signal), { catalogue: "read", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true });
  let interrupted = false;
  const failing: Client = { ...ownerClient, mutate: ((path, input, options) => {
    if (path === "zerotrust.domains.put" && !interrupted) { interrupted = true; return Promise.resolve([null, new Error("Synthetic interrupted access change")]); }
    return ownerClient.mutate(path, input, options);
  }) as Client["mutate"] };
  await assert.rejects(() => changeMemberAccess(failing, subject, { catalogue: "none", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: false }, signal));
  assert.equal(interrupted, true);
  assert.deepEqual(await memberAccess(ownerClient, subject, signal), { catalogue: "none", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: false });
  const pending = await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }));
  assert.equal(pending.find(domain => domain.id === before.id)!.rotationRequired, true);
  const blocked = await openProtectedProducts(ownerClient, signal, driver);
  try {
    const first = (await blocked.list({}))[0]!;
    await assert.rejects(() => blocked.update({ id: first.id, data: { name: canary } }));
  } finally { await blocked.close(); }
  assert.ok((await memberClient.query("zerotrust.keys.get", { domain: before.id, generation: before.generation }, { strategy: "network-only" }))[1]);
  await finishAccessChanges(ownerClient, signal);
  const after = (await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).find(domain => domain.id === before.id)!;
  assert.equal(after.generation, (BigInt(before.generation) + 1n).toString()); assert.equal(after.rotationRequired, false);
  const dormant = await required(ownerClient.query("zerotrust.domains.get", { domain: personal.domain, generation: "2" }, { strategy: "network-only" }));
  assert.deepEqual(dormant.envelopes, [], "No ordinary reader receives the disabled personal area's new key");
  assert.ok((await memberClient.query("zerotrust.keys.get", { domain: after.id, generation: after.generation }, { strategy: "network-only" }))[1]);
  const products = await openProtectedProducts(ownerClient, signal, driver);
  let productId: string;
  try { productId = (await products.list({}))[0]!.id; await products.update({ id: productId, data: { name: canary } }); }
  finally { await products.close(); }
  const collection = await protectedCollection(ownerClient, PRODUCT_COLLECTION, signal);
  try {
    const changed = (await collection.read()).find(value => (value.value as ProductPayload).product.values.name === canary)!;
    assert.ok(changed); assert.equal(changed.envelope.generation, after.generation);
    const { format: _format, nonce: _nonce, ciphertext: _ciphertext, wrappedKey: _wrappedKey, signature: _signature, ...context } = changed.envelope;
    await assert.rejects(() => decryptObject(changed.envelope, context, oldKey, owner.identity.signingKey.publicKey),
      "Even with the new ciphertext, the previously granted key cannot decrypt the new content");
  } finally { collection.close(); }
  let lost = false;
  const lostAcknowledgement: Client = { ...ownerClient, mutate: (async (path, input, options) => {
    const result = await ownerClient.mutate(path, input, options);
    if (path === "zerotrust.policy.replace" && !result[1] && !lost) { lost = true; return [null, new Error("Synthetic lost policy acknowledgement")]; }
    return result;
  }) as Client["mutate"] };
  await changeMemberAccess(lostAcknowledgement, subject, { catalogue: "write", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true }, signal);
  assert.equal(lost, true);
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const business = createBusinessClient(memberClient, { openProducts: (client, cancellation) => openProtectedProducts(client, cancellation, driver) });
  try {
    assert.equal((await required(business.query("products.get", { id: productId })))!.name, canary);
    await required(business.mutate("products.update", { id: productId, data: { description: "Nach erneuter Freigabe bearbeitet" } }));
    assert.equal((await required(business.query("llm.chats.list", undefined))).length, 1, "Re-enabled personal history retains its historical key");
    await required(business.mutate("llm.chats.create", { title: "Nach erneuter Freigabe" }));
  } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  await testDirectoryGrants(ownerClient, memberClient, owner, member, driver, signal);
  await testProjectPermissions(ownerClient, memberClient, owner, member, driver, signal);
  console.log("Access changes verified: interrupted revocation freezes writes, resumes key rotation, excludes removed readers cryptographically, and restores history and editing after regrant with a lost policy acknowledgement.");
  return canary;
}

async function testDirectoryGrants(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const subject = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id;
  const preserved = { vendors: "none" as const, catalogue: "write" as const, prices: "none" as const, assistant: true };
  for (const access of [{ customers: "read", contacts: "none" }, { customers: "none", contacts: "read" }] as const) {
    await changeMemberAccess(ownerClient, `user:${subject}`, { ...preserved, ...access }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    const keys: string[] = [], observed: Client = { ...memberClient, query: ((path, input, options) => {
      if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain); return memberClient.query(path, input, options);
    }) as Client["query"] };
    const business = createBusinessClient(observed, { productDriver: driver });
    try {
      const permitted = access.customers === "read" ? "customers" : "contacts", denied = permitted === "customers" ? "contacts" : "customers";
      assert.ok((await required(business.query(`${permitted}.list`, {}))).length);
      assert.ok((await business.query(`${denied}.list`, {}))[1]);
      assert.equal(keys.includes((denied === "customers" ? CUSTOMER_COLLECTION : CONTACT_COLLECTION).domain), false);
      assert.ok((await business.mutate("customers.create", { name: "Must stay denied" }))[1]);
      assert.ok((await business.mutate("contacts.create", { firstName: "Must stay denied" }))[1]);
    } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  }
  await changeMemberAccess(ownerClient, `user:${subject}`, { ...preserved, customers: "write", contacts: "none" }, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const customerArea = await protectedCollection(memberClient, CUSTOMER_COLLECTION, signal);
  try {
    const existing = (await customerArea.read()).find(item => (item.value as AddressPayload).row)!;
    const packet = await customerArea.packet(existing.envelope.object, existing.value, existing.envelope);
    const [, error] = await memberClient.mutate("zerotrust.objects.batch", { objects: [packet], heads: [
      { domain: CUSTOMER_COLLECTION.domain, sequence: customerArea.snapshot() }, { domain: CONTACT_COLLECTION.domain, sequence: "0" },
    ] });
    assert.ok(error, "A read guard cannot reference an area without current read permission");
  } finally { customerArea.close(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  await changeMemberAccess(ownerClient, `user:${subject}`, { ...preserved, customers: "write", contacts: "read" }, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const linking = createBusinessClient(memberClient, { productDriver: driver });
  try {
    const contact = (await required(linking.query("contacts.list", {})))[0]!;
    const customer = await required(linking.mutate("customers.create", { name: "Kunde mit lesbarem Ansprechpartner" }));
    await required(linking.mutate("customers.contacts.add", { customerId: customer.id, contactId: contact.id }));
    assert.equal((await required(linking.query("customers.contacts.list", { customerId: customer.id })))[0]!.id, contact.id,
      "A reference guard requires contact read permission, not contact write permission");
    assert.ok((await linking.mutate("contacts.update", { id: contact.id, data: { firstName: "Must stay denied" } }))[1]);
  } finally { linking.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  await changeMemberAccess(ownerClient, `user:${subject}`, { ...preserved, customers: "write", contacts: "write" }, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const business = createBusinessClient(memberClient, { productDriver: driver });
  try {
    const customer = await required(business.mutate("customers.create", { name: "Kunde mit gezielter Schreibfreigabe" }));
    const contact = await required(business.mutate("contacts.create", { firstName: "Freigegebener Ansprechpartner" }));
    await required(business.mutate("customers.contacts.add", { customerId: customer.id, contactId: contact.id }));
    assert.equal((await required(business.query("customers.contacts.list", { customerId: customer.id })))[0]!.id, contact.id);
  } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  console.log("Directory grants verified: customer-only/contact-only readers, denied writes and unreadable read guards, historical keys after regrant, and certified member CRUD/relationships.");
}

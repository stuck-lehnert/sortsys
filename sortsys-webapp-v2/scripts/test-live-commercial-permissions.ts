import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { areaKey, decryptObject, domainBoxSigner, openBox, verifyDomain } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeCommercialAccess, changeCommercialCreation, changeProjectCreation, memberCommercialCreation } from "../app/lib/crypto/permissions";
import { COMMERCIAL_FACETS, commercialCollection } from "../app/lib/data/commercialAreas";
import { createResourceArea } from "../app/lib/data/createProjectArea";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { newProductRowId, publicId } from "../app/lib/data/products";
import type { DuckDriver } from "../app/lib/data/database";
import { testCommercialCaseAccess } from "./test-live-commercial-access";

/** Cryptographic admission, independently from business workflow validation. */
export async function testCommercialPermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const memberId = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id, subject = `user:${memberId}`;
  const ownerId = (await required(ownerClient.query("auth.sessionInfo", undefined))).user.id;
  const id = publicId(newProductRowId()), master = commercialCollection(id, "master-data"), prices = commercialCollection(id, "offer-prices"), scope = commercialCollection(id, "scope");
  assert.equal(await memberCommercialCreation(ownerClient, subject, signal), false);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try { await assert.rejects(() => createResourceArea(memberClient, master, "commercial", signal)); }
  finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  await changeProjectCreation(ownerClient, subject, true, signal);
  await changeCommercialCreation(ownerClient, subject, true, signal);
  assert.equal(await memberCommercialCreation(ownerClient, subject, signal), true);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  let oldPriceKey: CryptoKey;
  try {
    const projectCapability = await required(memberClient.query("zerotrust.creations.capability", { namespace: "project" }, { strategy: "network-only" }));
    const commercialCapability = await required(memberClient.query("zerotrust.creations.capability", { namespace: "commercial" }, { strategy: "network-only" }));
    assert.equal(projectCapability.namespace, "project"); assert.equal(commercialCapability.namespace, "commercial");
    assert.notEqual(projectCapability.id, commercialCapability.id, "Publishing a commercial capability must not overwrite the project capability");
    await assert.rejects(() => createResourceArea(memberClient, prices, "commercial", signal), "A creator cannot attach a facet before the same case's certified master area exists");
    await createResourceArea(memberClient, master, "commercial", signal);
    for (const facet of COMMERCIAL_FACETS) {
      const area = commercialCollection(id, facet);
      if (facet !== "master-data") await createResourceArea(memberClient, area, "commercial", signal);
      const collection = await protectedCollection(memberClient, area, signal);
      try {
        await collection.read();
        await collection.write([await collection.packet(`${area.prefix}test`, { format: "sortsys-commercial-permission-test-v1", facet, value: facet === "offer-prices" ? "592.00" : `Independent ${facet}` })]);
      } finally { collection.close(); }
      const definition = await required(memberClient.query("zerotrust.domains.get", { domain: area.domain, generation: "1" }));
      assert.equal(definition.creation?.capability.namespace, "commercial");
      assert.deepEqual(definition.envelopes.map(box => box.recipient).sort(), [subject, `user:${ownerId}`].sort());
    }
    const history = await trustedHistory(memberClient), definition = await verifyDomain(
      await required(memberClient.query("zerotrust.domains.get", { domain: prices.domain, generation: "1" })),
      { tenant: member.tenant, id: prices.domain, scope: prices.scope, facet: prices.facet, generation: "1" }, history.authority);
    const box = await required(memberClient.query("zerotrust.keys.get", { domain: prices.domain, generation: "1" }));
    const raw = await openBox(box, { tenant: member.tenant, purpose: "area-key", object: prices.domain, generation: "1", recipient: subject, author: box.author }, member.identity.encryptionKey.privateKey, await domainBoxSigner(definition, box, history.authority));
    try { oldPriceKey = await areaKey(raw); } finally { raw.fill(0); }
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  for (const facet of COMMERCIAL_FACETS) {
    const collection = await protectedCollection(ownerClient, commercialCollection(id, facet), signal);
    try { assert.equal((await collection.read()).length, 1, "The mandatory administrator must be able to open each independently keyed facet"); }
    finally { collection.close(); }
  }
  await changeProjectCreation(ownerClient, subject, false, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try {
    assert.equal((await memberClient.query("zerotrust.creations.capability", { namespace: "project" }, { strategy: "network-only" }))[0], null);
    assert.ok((await memberClient.query("zerotrust.creations.capability", { namespace: "commercial" }, { strategy: "network-only" }))[0]);
    await createResourceArea(memberClient, commercialCollection(publicId(newProductRowId()), "master-data"), "commercial", signal);
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  await changeCommercialAccess(ownerClient, subject, id, "offer-prices", "read", signal);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try {
    const collection = await protectedCollection(memberClient, prices, signal);
    try {
      const objects = await collection.read(); assert.equal(objects.length, 1);
      await assert.rejects(() => collection.packet(objects[0]!.envelope.object, { value: "Denied update" }, objects[0]!.envelope));
    } finally { collection.close(); }
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  await changeCommercialAccess(ownerClient, subject, id, "offer-prices", "none", signal);
  const collection = await protectedCollection(ownerClient, prices, signal);
  try {
    const original = (await collection.read())[0]!;
    const packet = await collection.packet(original.envelope.object, { format: "sortsys-commercial-permission-test-v1", facet: "offer-prices", value: "879.25" }, original.envelope);
    await collection.write([packet]);
    const { format: _format, nonce: _nonce, ciphertext: _ciphertext, wrappedKey: _wrapped, signature: _signature, ...context } = packet.envelope;
    await assert.rejects(() => decryptObject(packet.envelope, context, oldPriceKey!, owner.identity.signingKey.publicKey));
  } finally { collection.close(); }
  await changeCommercialCreation(ownerClient, subject, false, signal);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try {
    await assert.rejects(() => createResourceArea(memberClient, commercialCollection(publicId(newProductRowId()), "master-data"), "commercial", signal));
    assert.ok((await memberClient.query("zerotrust.keys.get", { domain: prices.domain, generation: "2" }))[1]);
    const collection = await protectedCollection(memberClient, scope, signal);
    try {
      const original = (await collection.read())[0]!;
      await collection.write([await collection.packet(original.envelope.object, { format: "sortsys-commercial-permission-test-v1", facet: "scope", value: "Scope remains editable" }, original.envelope)]);
    } finally { collection.close(); }
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  console.log("Commercial area admission verified: independent project/commercial capabilities, mandatory readers, isolated facet keys, price downgrade/revocation and retained scope editing.");
  await testCommercialCaseAccess(ownerClient, memberClient, owner, member, driver, signal);
}

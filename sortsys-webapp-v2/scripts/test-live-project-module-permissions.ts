import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { areaKey, decryptObject, domainBoxSigner, openBox, verifyDomain } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeProjectAccess, memberProjectAccess } from "../app/lib/crypto/permissions";
import { PROJECT_ACCESS_KEYS, projectAccessArea } from "../app/lib/data/projectScope";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";

export async function testProjectModulePermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, project: string, signal: AbortSignal) {
  const subject = `user:${(await required(memberClient.query("auth.sessionInfo", undefined))).user.id}`;
  const keys = PROJECT_ACCESS_KEYS.filter(key => key.includes(":"));
  const areas = keys.map(key => ({ ...projectAccessArea(project, key), prefix: `module-test:${key}:` }));
  const ownerId = (await required(ownerClient.query("auth.sessionInfo", undefined))).user.id;
  await provisionOwnedCollections(ownerClient, `user:${ownerId}`, areas, signal);
  async function write(index: number, text: string) {
    const area = areas[index]!, collection = await protectedCollection(ownerClient, area, signal);
    try { await collection.read(); const packet = await collection.packet(`${area.prefix}probe`, { text }); await collection.write([packet]); return packet.envelope; }
    finally { collection.close(); }
  }
  for (let index = 0; index < areas.length; index++) await write(index, "Nur für diesen Berichtsbereich");
  for (let index = 0; index < areas.length; index++) {
    const key = keys[index]!, area = areas[index]!;
    await changeProjectAccess(ownerClient, subject, project, "read", signal, key);
    assert.equal((await memberProjectAccess(ownerClient, subject, signal, key))[project], "read");
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    let known: CryptoKey;
    try {
      const history = await trustedHistory(memberClient);
      for (const other of areas) {
        if (other !== area) {
          await assert.rejects(() => protectedCollection(memberClient, other, signal));
          assert.ok((await memberClient.query("zerotrust.keys.get", { domain: other.domain, generation: "1" }, { strategy: "network-only" }))[1]);
          continue;
        }
        const collection = await protectedCollection(memberClient, other, signal);
        try {
          const [entry] = await collection.read(); assert.deepEqual(entry!.value, { text: "Nur für diesen Berichtsbereich" });
          await assert.rejects(() => collection.packet(`${area.prefix}probe`, { text: "Kein Schreibrecht" }));
        } finally { collection.close(); }
      }
      const current = (await required(memberClient.query("zerotrust.domains.list", undefined))).find(domain => domain.id === area.domain)!;
      const definition = await verifyDomain(await required(memberClient.query("zerotrust.domains.get", { domain: area.domain, generation: current.generation }, { strategy: "network-only" })),
        { tenant: member.tenant, id: area.domain, scope: area.scope, facet: area.facet, generation: current.generation }, history.authority);
      const box = await required(memberClient.query("zerotrust.keys.get", { domain: area.domain, generation: current.generation }, { strategy: "network-only" }));
      const raw = await openBox(box, { tenant: member.tenant, purpose: "area-key", object: area.domain, generation: current.generation, recipient: subject, author: box.author }, member.identity.encryptionKey.privateKey, await domainBoxSigner(definition, box, history.authority));
      try { known = await areaKey(raw); } finally { raw.fill(0); }
    } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    await changeProjectAccess(ownerClient, subject, project, "none", signal, key);
    const envelope = await write(index, "Nach Entzug verschlüsselt");
    const { format: _format, nonce: _nonce, ciphertext: _ciphertext, wrappedKey: _wrappedKey, signature: _signature, ...context } = envelope;
    await assert.rejects(() => decryptObject(envelope, context, known!, owner.identity.signingKey.publicKey));
    await changeProjectAccess(ownerClient, subject, project, "read", signal, key);
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    try {
      const collection = await protectedCollection(memberClient, area, signal);
      try { assert.deepEqual((await collection.read())[0]!.value, { text: "Nach Entzug verschlüsselt" }); }
      finally { collection.close(); }
    } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    await changeProjectAccess(ownerClient, subject, project, "none", signal, key);
  }
  console.log("Independent project report keys verified: individual grants, read-only access, revocation, rotation and historical regrant.");
}

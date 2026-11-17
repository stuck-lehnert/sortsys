import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { areaKey, bytes, decryptObject, domainBoxSigner, encryptObject, openBox, verifyDomain, type EncryptedObject } from "@sortsys/zerotrust/sortsys";
import { acceptVaultWithKey, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeProjectAccess, memberProjectAccess } from "../app/lib/crypto/permissions";
import { commitProtectedWrites } from "../app/lib/data/atomicWrites";
import { openProjectCommercial, projectCommercialCollection, PROJECT_COMMERCIAL_FACETS } from "../app/lib/data/projectCommercial";
import { projectCollection } from "../app/lib/data/projectData";
import { protectedCollection, required, type Collection } from "../app/lib/data/protectedObjects";

function context(envelope: EncryptedObject) { const { format, nonce, ciphertext, wrappedKey, signature, ...binding } = envelope; return binding; }
async function key(client: Client, account: UnlockedAccount, area: Collection, generation: string) {
  const history = await trustedHistory(client), definition = await required(client.query("zerotrust.domains.get", { domain: area.domain, generation }, { strategy: "network-only" }));
  const verified = await verifyDomain(definition, { tenant: account.tenant, id: area.domain, scope: area.scope, facet: area.facet, generation }, history.authority);
  const box = await required(client.query("zerotrust.keys.get", { domain: area.domain, generation }, { strategy: "network-only" }));
  const subject = `user:${(await required(client.query("auth.sessionInfo", undefined))).user.id}`;
  const raw = await openBox(box, { tenant: account.tenant, purpose: "area-key", object: area.domain, generation, recipient: subject, author: box.author }, account.identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, history.authority));
  try { return await areaKey(raw); } finally { raw.fill(0); }
}

export async function testProjectCommercialPermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, projectId: string, signal: AbortSignal) {
  const memberId = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id, user = `user:${memberId}`;
  const master = projectCollection(projectId), source: { area: Collection; envelope: EncryptedObject }[] = [];
  for (const facet of PROJECT_COMMERCIAL_FACETS) {
    const area = projectCommercialCollection(projectId, facet), collection = await protectedCollection(ownerClient, area, signal);
    try { source.push({ area, envelope: (await collection.read(`${area.prefix}register`))[0]!.envelope }); } finally { collection.close(); }
  }
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try {
    const domains = await required(memberClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" })), generation = domains.find(domain => domain.id === master.domain)!.generation;
    const masterKey = await key(memberClient, member, master, generation), history = await trustedHistory(memberClient);
    for (const { area, envelope } of source) {
      assert.ok((await memberClient.query("zerotrust.keys.get", { domain: area.domain, generation: "1" }, { strategy: "network-only" }))[1]);
      const signer = await history.signer(envelope);
      await assert.rejects(() => decryptObject(envelope, context(envelope), masterKey, signer), "A project master-data key cannot open contract values or awarded positions");
    }
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  for (const facet of PROJECT_COMMERCIAL_FACETS) {
    const area = projectCommercialCollection(projectId, facet), other = projectCommercialCollection(projectId, facet === "offer-prices" ? "procurement" : "offer-prices");
    await changeProjectAccess(ownerClient, user, projectId, "read", signal, facet);
    assert.equal((await memberProjectAccess(ownerClient, user, signal, facet))[projectId], "read");
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    let old: EncryptedObject, oldKey: CryptoKey, currentKey: CryptoKey;
    try {
      const register = await openProjectCommercial(memberClient, projectId, facet, signal);
      try { assert.equal(register.value.facet, facet); await assert.rejects(() => register.prepare(register.value)); } finally { register.close(); }
      assert.ok((await memberClient.query("zerotrust.keys.get", { domain: other.domain, generation: "1" }, { strategy: "network-only" }))[1]);
      const collection = await protectedCollection(memberClient, area, signal);
      try {
        const object = (await collection.read(`${area.prefix}register`))[0]!; old = object.envelope;
        const authority = collection.authorization(); oldKey = await key(memberClient, member, area, old.generation); currentKey = await key(memberClient, member, area, authority.keyGeneration);
        const proposal = await encryptObject({ ...context(old), revision: (BigInt(old.revision) + 1n).toString(), generation: authority.keyGeneration, policyVersion: authority.policyVersion, author: user }, bytes(JSON.stringify(object.value)), currentKey, member.identity.signingKey.privateKey);
        const denied = await memberClient.mutate("zerotrust.objects.batch", { objects: [{ domain: area.domain, messageId: `forbidden_${facet}`, envelope: proposal }], heads: [{ domain: area.domain, sequence: collection.snapshot() }] });
        const error = denied[1]; assert.ok(error && "code" in error);
        assert.equal(error.code, "FORBIDDEN", "The native API must reject a correctly signed write from a read-only key holder");
      } finally { collection.close(); }
    } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    await changeProjectAccess(ownerClient, user, projectId, "none", signal, facet);
    const register = await openProjectCommercial(ownerClient, projectId, facet, signal);
    try { await commitProtectedWrites(ownerClient, [await register.prepare(register.value)], signal); } finally { register.close(); }
    const current = await protectedCollection(ownerClient, area, signal);
    try {
      const updated = (await current.read(`${area.prefix}register`))[0]!.envelope, history = await trustedHistory(ownerClient);
      const signer = await history.signer(updated);
      for (const stale of [oldKey!, currentKey!]) await assert.rejects(() => decryptObject(updated, context(updated), stale, signer));
    } finally { current.close(); }
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    try { await assert.rejects(() => openProjectCommercial(memberClient, projectId, facet, signal)); } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    await changeProjectAccess(ownerClient, user, projectId, "read", signal, facet);
    await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
    try {
      const register = await openProjectCommercial(memberClient, projectId, facet, signal);
      try { assert.equal(register.value.facet, facet); } finally { register.close(); }
      const historicKey = await key(memberClient, member, area, old!.generation), history = await trustedHistory(memberClient);
      const opened = await decryptObject(old!, context(old!), historicKey, await history.signer(old!)); opened.fill(0);
    } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    await changeProjectAccess(ownerClient, user, projectId, "none", signal, facet);
  }
  console.log("Project contract/award grants verified: independent master/value/award keys, native rejection of correctly signed read-only writes, revocation excludes retained keys and regrant restores historical ciphertext.");
}

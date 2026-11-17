import assert from "node:assert/strict";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { areaKey, base64, bytes, domainBoxSigner, encryptObject, objectFrame, openBox, randomSecret, sign, TOMBSTONE_FORMAT, verifyDomain } from "@sortsys/zerotrust/sortsys";
import { changeAreaActionAccesses, changeProjectAccess } from "../app/lib/crypto/permissions";
import { acceptVaultWithKey, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { projectCollection } from "../app/lib/data/projectData";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";

export async function testDeleteOnlyAccess(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const subject = `user:${(await required(memberClient.query("auth.sessionInfo", undefined))).user.id}`;
  const root = createBusinessClient(ownerClient, { productDriver: driver });
  let project: { id: string };
  try { project = await required(root.mutate("projects.create", { title: "Prüfung eigener Löschrechte" })); }
  finally { root.dispose(); }
  const area = projectCollection(project.id);
  await changeProjectAccess(ownerClient, subject, project.id, "read", signal);
  await changeAreaActionAccesses(ownerClient, subject, [{ area, patch: { delete: true } }], signal);
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  let key: CryptoKey, original: unknown;
  const deletions: MutateInput<"zerotrust.objects.batch">[] = [];
  try {
    const history = await trustedHistory(memberClient), collection = await protectedCollection(memberClient, area, signal);
    try {
      const entry = await collection.get(area.prefix); original = entry.value;
      const current = (await required(memberClient.query("zerotrust.domains.list", undefined))).find(value => value.id === area.domain)!;
      const definition = await verifyDomain(await required(memberClient.query("zerotrust.domains.get", { domain: area.domain, generation: current.generation }, { strategy: "network-only" })),
        { tenant: member.tenant, id: area.domain, scope: area.scope, facet: area.facet, generation: current.generation }, history.authority);
      const box = await required(memberClient.query("zerotrust.keys.get", { domain: area.domain, generation: current.generation }, { strategy: "network-only" }));
      const raw = await openBox(box, { tenant: member.tenant, purpose: "area-key", object: area.domain, generation: current.generation, recipient: subject, author: box.author }, member.identity.encryptionKey.privateKey, await domainBoxSigner(definition, box, history.authority));
      try { key = await areaKey(raw); } finally { raw.fill(0); }
      const policy = await required(memberClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
      const envelope = await encryptObject({ tenant: member.tenant, scope: area.scope, facet: area.facet, object: area.prefix, revision: (BigInt(entry.envelope.revision) + 1n).toString(),
        generation: current.generation, policyVersion: policy.version, author: subject }, bytes(JSON.stringify(original)), key, member.identity.signingKey.privateKey);
      const packet = { domain: area.domain, messageId: `msg_${base64(randomSecret())}`, envelope };
      const guards = [{ domain: area.domain, sequence: await collection.inspect() }];
      assert.ok((await memberClient.mutate("zerotrust.objects.batch", { objects: [packet], heads: guards }))[1], "Read/delete cannot authorize a correctly signed ordinary update");
      const disguised: typeof envelope = { ...envelope, format: TOMBSTONE_FORMAT };
      disguised.signature = await sign(member.identity.signingKey.privateKey, objectFrame(disguised));
      assert.ok((await memberClient.mutate("zerotrust.objects.batch", { objects: [{ ...packet, envelope: disguised }], heads: guards }))[1], "A deletion marker cannot carry ordinary encrypted business values");
    } finally { collection.close(); }
    const losingReply: Client = { ...memberClient, mutate: (async (path, input, options) => {
      const result = await memberClient.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && !result[1]) { deletions.push(structuredClone(input) as MutateInput<"zerotrust.objects.batch">); throw new Error("Synthetic lost deletion acknowledgement"); }
      return result;
    }) as Client["mutate"] };
    const business = createBusinessClient(losingReply, { productDriver: driver });
    try { assert.deepEqual(await required(business.mutate("projects.delete", { id: project.id })), { success: true }); }
    finally { business.dispose(); }
    const deleted = deletions[0]; assert.ok(deleted); assert.equal(deleted.objects[0]!.envelope.format, TOMBSTONE_FORMAT);
    assert.equal((await required(memberClient.mutate("zerotrust.objects.batch", deleted))).success, true, "An exact deletion replay is idempotent");
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  try {
    const current = await protectedCollection(ownerClient, area, signal);
    try {
      assert.deepEqual(await current.read(), []);
      const tombstone = await current.get(area.prefix); assert.equal(tombstone.envelope.format, TOMBSTONE_FORMAT);
      const ownerId = (await required(ownerClient.query("auth.sessionInfo", undefined))).user.id;
      const policy = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
      const envelope = await encryptObject({ tenant: owner.tenant, scope: area.scope, facet: area.facet, object: area.prefix, revision: (BigInt(tombstone.envelope.revision) + 1n).toString(),
        generation: tombstone.envelope.generation, policyVersion: policy.version, author: `user:${ownerId}` }, bytes(JSON.stringify(original)), key!, owner.identity.signingKey.privateKey);
      assert.ok((await ownerClient.mutate("zerotrust.objects.batch", { objects: [{ domain: area.domain, messageId: `msg_${base64(randomSecret())}`, envelope }], heads: [{ domain: area.domain, sequence: current.snapshot() }] }))[1], "Even a normal writer cannot resurrect a deleted object ID");
    } finally { current.close(); }
  } finally { await changeProjectAccess(ownerClient, subject, project.id, "none", signal); }
  console.log("Delete-only access verified: signed empty body, no arbitrary edits, lost reply readback, identical replay and no resurrection through another API connection.");
}

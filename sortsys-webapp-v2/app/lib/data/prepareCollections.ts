import type { Client } from "@sortsys/v2-client";
import { ACTIONS, allows, createDomain, InvalidProtectedData, policy, policyFrame, publicIdentity, record, signPolicy, verify } from "@sortsys/zerotrust";
import { openAuthority } from "../crypto/setup";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { required } from "./protectedObjects";
import type { Collection } from "./protectedObjects";

/** Authority-only migration/bootstrap. Runtime readers never get the authority
 * key. New readers require separately certified identities and explicit grants. */
export async function prepareOwnerCollections(client: Client, subject: string, collections: Collection[], signal: AbortSignal): Promise<void> {
  return provisionOwnedCollections(client, subject, collections, signal, true);
}

/** Creating fresh business areas is separate from reading the frozen source.
 * This path still requires the tenant authority's locally unlocked key. */
export async function provisionOwnedCollections(client: Client, subject: string, collections: Collection[], signal: AbortSignal, migrationOnly = false): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => { if (signal.aborted || unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const status = await required(client.query("zerotrust.status", undefined, { strategy: "network-only" })); live();
  if (status.tenant !== account.tenant || !["enrolling", ...(!migrationOnly ? ["active"] : [])].includes(status.phase) || !status.profile) throw new InvalidProtectedData();
  const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  if (subject !== `user:${session.user.id}`) throw new InvalidProtectedData();
  const history = await trustedHistory(client); live();
  const authority = await openAuthority(client, status.profile); live();
  const current = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...raw } = current;
  if (typeof signature !== "string") throw new InvalidProtectedData();
  let permissions = policy(raw);
  if (permissions.tenant !== account.tenant) throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  const missing = collections.filter(collection => !ACTIONS.every(action => allows(permissions, { tenant: account.tenant,
    version: permissions.version, subjects: [subject], scope: collection.scope, facet: collection.facet, action })));
  if (missing.length) {
    const next = await signPolicy({ tenant: account.tenant, version: (BigInt(permissions.version) + 1n).toString(), rules: [
      ...permissions.rules, ...missing.map(c => ({ subject, scope: c.scope, facet: c.facet, actions: [...ACTIONS], effect: "allow" as const })),
    ] }, authority);
    await required(client.mutate("zerotrust.policy.replace", next));
    permissions = next; live();
  }
  let domains = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }));
  for (const c of collections) {
    live();
    if (!domains.some(d => d.id === c.domain)) {
      const made = await createDomain({ tenant: account.tenant, id: c.domain, scope: c.scope, facet: c.facet,
        generation: "1", policyVersion: permissions.version, authorityGeneration: history.current.generation, authorityKey: authority,
        recovery: { encryptionKey: history.current.recoveryEncryptionKey, signingKey: history.current.recoverySigningKey },
        readers: [{ subject, identity: await publicIdentity(account.identity) }],
      });
      const [, failure] = await client.mutate("zerotrust.domains.put", made.definition);
      const [saved, readError] = await client.query("zerotrust.domains.get", { domain: c.domain, generation: "1" }, { strategy: "network-only" }); live();
      if (!saved || saved.proof !== made.definition.proof) throw failure ?? readError ?? new InvalidProtectedData();
      domains.push({ id: c.domain, scope: c.scope, facet: c.facet, generation: "1", rotationRequired: false });
    }
  }
}

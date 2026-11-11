import type { Client } from "@sortsys/v2-client";
import { allows, CREATION_FACETS, creationResource, creationScope, createDelegatedDomain, createOrigin, InvalidProtectedData, policy, policyFrame, publicIdentity, record, verify, verifyCreationCapability, type CreationNamespace } from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { required, type Collection } from "./protectedObjects";
import { provisionOwnedCollections } from "./prepareCollections";
import { addressId } from "./addressBook";

export async function createProjectArea(client: Client, area: Collection, signal: AbortSignal): Promise<void> {
  return createResourceArea(client, area, "project", signal);
}
export async function createResourceArea(client: Client, area: Collection, namespace: CreationNamespace, signal: AbortSignal): Promise<void> {
  const account = unlockedAccount();
  const resource = creationResource(area.scope);
  if (!account || !Object.hasOwn(CREATION_FACETS, namespace) || !(CREATION_FACETS[namespace] as readonly string[]).includes(area.facet)
    || area.domain !== `${area.scope}:${area.facet}` || !resource || resource.namespace !== namespace) throw new InvalidProtectedData();
  addressId(resource.id);
  const live = () => { signal.throwIfAborted(); if (unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const history = await trustedHistory(client), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  const subject = `user:${session.user.id}`;
  const [input, failure] = await client.query("zerotrust.creations.capability", { namespace }, { strategy: "network-only" }); live();
  if (failure) throw failure;
  if (!input) {
    if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
    return provisionOwnedCollections(client, subject, [area], signal);
  }
  const capability = await verifyCreationCapability(input, history.authority(history.current.generation)); live();
  const identity = await publicIdentity(account.identity);
  if (capability.tenant !== account.tenant || capability.generation !== history.current.generation || capability.namespace !== namespace || capability.creator.user !== subject
    || capability.creator.signingKey !== identity.signingKey || capability.creator.encryptionKey !== identity.encryptionKey) throw new InvalidProtectedData();
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw, permissions = policy(unsigned);
  if (typeof signature !== "string") throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  if (!allows(permissions, { tenant: account.tenant, version: permissions.version, subjects: [subject], scope: creationScope(namespace), facet: "master-data", action: "create" })) throw new InvalidProtectedData();
  const origin = await createOrigin({ tenant: account.tenant, id: area.domain, scope: area.scope, facet: area.facet, capability }, account.identity.signingKey.privateKey);
  const { definition } = await createDelegatedDomain({ origin, creatorKey: account.identity.signingKey.privateKey, policyVersion: permissions.version,
    recovery: { encryptionKey: history.current.recoveryEncryptionKey, signingKey: history.current.recoverySigningKey } }); live();
  const [, error] = await client.mutate("zerotrust.domains.put", definition); live();
  // A lost acknowledgement may have committed. Only the identical signed
  // definition proves success; another writer's matching domain name does not.
  const [saved, readError] = await client.query("zerotrust.domains.get", { domain: area.domain, generation: "1" }, { strategy: "network-only" }); live();
  if (!saved || saved.proof !== definition.proof) throw error ?? readError ?? new InvalidProtectedData();
}

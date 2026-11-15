import type { Client } from "@sortsys/v2-client";
import {
  allows,
  CREATION_FACETS,
  creationFacets,
  creationResource,
  creationScope,
  createDelegatedDomain,
  createOrigin,
  InvalidProtectedData,
  publicIdentity,
  verifyCreationCapability,
  verifyDomain,
  type CreationNamespace,
  type CreationParent,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { readVerifiedPolicy } from "../crypto/policy";
import { required, type Collection } from "./protectedObjects";
import { provisionOwnedCollections } from "./prepareCollections";
import { addressId } from "./addressBook";

export async function createProjectArea(
  client: Client,
  area: Collection,
  signal: AbortSignal,
): Promise<void> {
  return createResourceAreas(client, [area], "project", signal);
}

export async function createResourceArea(
  client: Client,
  area: Collection,
  namespace: CreationNamespace,
  signal: AbortSignal,
): Promise<void> {
  return createResourceAreas(client, [area], namespace, signal);
}

/** Provision a resource's facets together. Authority-created resources need
 * one policy publication, rather than a new policy per facet. */
export async function createResourceAreas(
  client: Client,
  areas: readonly Collection[],
  namespace: CreationNamespace,
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account || !Object.hasOwn(CREATION_FACETS, namespace)) {
    throw new InvalidProtectedData();
  }
  signal.throwIfAborted();
  const domains = new Set<string>();
  for (const area of areas) {
    const resource = creationResource(area.scope);
    if (
      !creationFacets(area.scope).includes(area.facet) ||
      area.domain !== `${area.scope}:${area.facet}` ||
      !resource ||
      resource.namespace !== namespace ||
      domains.has(area.domain)
    ) {
      throw new InvalidProtectedData();
    }
    addressId(resource.id);
    domains.add(area.domain);
  }
  if (!areas.length) return;
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  const history = await trustedHistory(client);
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  live();
  const subject = `user:${session.user.id}`;
  const [input, failure] = await client.query(
    "zerotrust.creations.capability",
    { namespace },
    { strategy: "network-only" },
  );
  live();
  if (failure) throw failure;
  if (!input) {
    if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
    return provisionOwnedCollections(client, subject, [...areas], signal);
  }
  const capability = await verifyCreationCapability(
    input,
    history.authority(history.current.generation),
  );
  live();
  const identity = await publicIdentity(account.identity);
  if (
    capability.tenant !== account.tenant ||
    capability.generation !== history.current.generation ||
    capability.namespace !== namespace ||
    capability.creator.user !== subject ||
    capability.creator.signingKey !== identity.signingKey ||
    capability.creator.encryptionKey !== identity.encryptionKey
  ) {
    throw new InvalidProtectedData();
  }
  const { permissions } = await readVerifiedPolicy(client, {
    account,
    history,
    live,
  });
  if (
    !allows(permissions, {
      tenant: account.tenant,
      version: permissions.version,
      subjects: [subject],
      scope: creationScope(namespace),
      facet: "master-data",
      action: "create",
    })
  ) {
    throw new InvalidProtectedData();
  }

  for (const area of areas) {
    const resource = creationResource(area.scope)!;
    let parent: CreationParent | undefined;
    if (resource.module) {
      const scope = `project:${resource.id}`;
      const id = `${scope}:master-data`;
      const original = await required(
        client.query(
          "zerotrust.domains.get",
          { domain: id, generation: "1" },
          { strategy: "network-only" },
        ),
      );
      live();
      if (!original) throw new InvalidProtectedData();
      const verified = await verifyDomain(
        original,
        {
          tenant: account.tenant,
          id,
          scope,
          facet: "master-data",
          generation: "1",
        },
        history.authority,
      );
      live();
      parent = verified.creation;
      if (
        !parent ||
        parent.capability.generation !== capability.generation ||
        parent.capability.creator.user !== subject ||
        parent.capability.creator.signingKey !== identity.signingKey ||
        parent.capability.creator.encryptionKey !== identity.encryptionKey
      ) {
        // A creation capability does not delegate authority over a recovered
        // or authority-created project's remaining modules.
        if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
        return provisionOwnedCollections(client, subject, [...areas], signal);
      }
    }
    const origin = await createOrigin(
      {
        tenant: account.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        capability,
        ...(parent ? { parent } : {}),
      },
      account.identity.signingKey.privateKey,
    );
    const { definition } = await createDelegatedDomain({
      origin,
      creatorKey: account.identity.signingKey.privateKey,
      policyVersion: permissions.version,
      recovery: {
        encryptionKey: history.current.recoveryEncryptionKey,
        signingKey: history.current.recoverySigningKey,
      },
    });
    live();
    const [, error] = await client.mutate("zerotrust.domains.put", definition);
    live();
    // A lost acknowledgement is accepted only for the identical signed
    // definition. A matching domain name from another writer is insufficient.
    const [saved, readError] = await client.query(
      "zerotrust.domains.get",
      { domain: area.domain, generation: "1" },
      { strategy: "network-only" },
    );
    live();
    if (!saved || saved.proof !== definition.proof) {
      throw error ?? readError ?? new InvalidProtectedData();
    }
  }
}

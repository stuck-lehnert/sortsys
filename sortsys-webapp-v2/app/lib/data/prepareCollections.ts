import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  allows,
  createDomain,
  InvalidProtectedData,
  publicIdentity,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { openAuthority } from "../crypto/setup";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { publishVerifiedPolicy, readVerifiedPolicy } from "../crypto/policy";
import { required } from "./protectedObjects";
import type { Collection } from "./protectedObjects";
import { publishDomainDefinitions } from "./domainDefinitions";

/** Initial areas belong to the locally unlocked tenant authority. Ordinary
 * readers receive separately certified identities and explicit key grants. */
export async function prepareOwnerCollections(
  client: Client,
  subject: string,
  collections: Collection[],
  signal: AbortSignal,
): Promise<void> {
  return provisionOwnedCollections(client, subject, collections, signal);
}

/** Provision areas in an initialized tenant. This requires the tenant
 * authority's locally unlocked key, including when adopting a backup. */
export async function provisionOwnedCollections(
  client: Client,
  subject: string,
  collections: Collection[],
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    if (signal.aborted || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  live();
  if (status.tenant !== account.tenant || !status.profile)
    throw new InvalidProtectedData();
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  live();
  if (subject !== `user:${session.user.id}`) throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  live();
  const authority = await openAuthority(client, status.profile);
  live();
  let { permissions } = await readVerifiedPolicy(client, {
    account,
    history,
    live,
  });
  const missing = collections.filter(
    (collection) =>
      !ACTIONS.every((action) =>
        allows(permissions, {
          tenant: account.tenant,
          version: permissions.version,
          subjects: [subject],
          scope: collection.scope,
          facet: collection.facet,
          action,
        }),
      ),
  );
  if (missing.length) {
    const next = {
      ...permissions,
      version: (BigInt(permissions.version) + 1n).toString(),
      rules: [
        ...permissions.rules,
        ...missing.map((c) => ({
          subject,
          scope: c.scope,
          facet: c.facet,
          actions: [...ACTIONS],
          effect: "allow" as const,
        })),
      ],
    };
    ({ permissions } = await publishVerifiedPolicy(
      client,
      { account, history, live, authority },
      next,
    ));
  }
  let domains = await required(
    client.query("zerotrust.domains.list", undefined, {
      strategy: "network-only",
    }),
  );
  const definitions: DomainDefinition[] = [];
  for (const c of collections) {
    live();
    if (!domains.some((d) => d.id === c.domain)) {
      const made = await createDomain({
        tenant: account.tenant,
        id: c.domain,
        scope: c.scope,
        facet: c.facet,
        generation: "1",
        policyVersion: permissions.version,
        authorityGeneration: history.current.generation,
        authorityKey: authority,
        recovery: {
          encryptionKey: history.current.recoveryEncryptionKey,
          signingKey: history.current.recoverySigningKey,
        },
        readers: [
          { subject, identity: await publicIdentity(account.identity) },
        ],
      });
      definitions.push(made.definition);
      domains.push({
        id: c.domain,
        scope: c.scope,
        facet: c.facet,
        generation: "1",
        rotationRequired: false,
      });
    }
  }
  await publishDomainDefinitions(client, definitions, signal);
  live();
}

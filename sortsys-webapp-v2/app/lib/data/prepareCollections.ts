import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  compilePolicy,
  createDomain,
  InvalidProtectedData,
  publicIdentity,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { openVerifiedAuthority } from "../crypto/setup";
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
  live();

  const [status, session, history] = await Promise.all([
    required(
      client.query("zerotrust.status", undefined, { strategy: "network-only" }),
    ),
    required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    ),
    trustedHistory(client),
  ]);
  live();
  if (status.tenant !== account.tenant || !status.profile)
    throw new InvalidProtectedData();
  if (subject !== `user:${session.user.id}`) throw new InvalidProtectedData();

  const authority = await openVerifiedAuthority(status.profile, account, history);
  live();
  let { permissions } = await readVerifiedPolicy(client, {
    account,
    history,
    live,
  });

  const access = compilePolicy(permissions, [subject]);
  const missing = collections.filter(
    ({ scope, facet }) =>
      !ACTIONS.every((action) => access.allows(scope, facet, action)),
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
  const domains = await required(
    client.query("zerotrust.domains.list", undefined, {
      strategy: "network-only",
    }),
  );
  live();

  const existing = new Set(domains.map(({ id }) => id));
  const definitions: DomainDefinition[] = [];
  let reader: Awaited<ReturnType<typeof publicIdentity>> | undefined;

  for (const c of collections) {
    live();
    if (existing.has(c.domain)) continue;

    reader ??= await publicIdentity(account.identity);
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
      readers: [{ subject, identity: reader }],
    });

    definitions.push(made.definition);
    existing.add(c.domain);
  }

  live();
  await publishDomainDefinitions(client, definitions, signal);
  live();
}

import type { Client } from "@sortsys/v2-client";
import {
  creationResource,
  creationRules,
  InvalidProtectedData,
  verifyCreationOrigin,
} from "@sortsys/zerotrust/sortsys";
import type { Policy } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import { trustedHistory } from "./session";

/** Derived rights are never represented as a root-signed policy. Verify the
 * immutable, certified origin separately and retain explicit root denials. */
export async function createdAccess(
  client: Client,
  permissions: Policy,
  history: Awaited<ReturnType<typeof trustedHistory>>,
  signal: AbortSignal,
  domain?: string,
): Promise<Policy> {
  const origins = await readCreationOrigins(client, domain);
  return verifyCreatedAccess(origins, permissions, history, signal, domain);
}

export async function readCreationOrigins(
  client: Client,
  domain?: string,
): Promise<readonly unknown[]> {
  if (domain && !creationResource(domain.slice(0, domain.lastIndexOf(":"))))
    return [];
  const [origin, error] = domain
    ? await client.query(
        "zerotrust.creations.origin",
        { domain },
        { strategy: "network-only" },
      )
    : [null, null];
  if (error) throw error;
  return domain
    ? [origin]
    : await required(
        client.query("zerotrust.creations.list", undefined, {
          strategy: "network-only",
        }),
      );
}

/** Raw transport results never grant access until every relevant origin is
 * verified against the pinned generation, tenant and requested domain. */
export async function verifyCreatedAccess(
  origins: readonly unknown[],
  permissions: Policy,
  history: Awaited<ReturnType<typeof trustedHistory>>,
  signal: AbortSignal,
  domains?: string | ReadonlySet<string>,
): Promise<Policy> {
  if (!Array.isArray(origins)) throw new InvalidProtectedData();
  signal.throwIfAborted();
  if (origins.length === 0) return permissions;
  const checked = await mapConcurrent(
    origins.filter((origin) => origin !== null),
    8,
    async (origin) => {
      signal.throwIfAborted();
      return verifyCreationOrigin(origin, history.authority);
    },
  );
  const inherited = [];
  const seen = new Set<string>();
  for (const origin of checked) {
    signal.throwIfAborted();
    if (
      origin.tenant !== permissions.tenant ||
      origin.capability.generation !== history.current.generation ||
      seen.has(origin.id) ||
      (typeof domains === "string" && origin.id !== domains) ||
      (typeof domains === "object" && !domains.has(origin.id))
    )
      throw new InvalidProtectedData();
    seen.add(origin.id);
    inherited.push(...creationRules(origin, permissions));
  }
  signal.throwIfAborted();
  return { ...permissions, rules: [...permissions.rules, ...inherited] };
}

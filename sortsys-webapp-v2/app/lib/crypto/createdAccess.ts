import type { Client } from "@sortsys/v2-client";
import {
  creationResource,
  creationRules,
  InvalidProtectedData,
  verifyCreationOrigin,
} from "@sortsys/zerotrust/sortsys";
import type { Policy } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
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
  if (domain && !creationResource(domain.slice(0, domain.lastIndexOf(":"))))
    return permissions;
  const [origin, error] = domain
    ? await client.query(
        "zerotrust.creations.origin",
        { domain },
        { strategy: "network-only" },
      )
    : [null, null];
  if (error) throw error;
  const origins = domain
    ? [origin]
    : await required(
        client.query("zerotrust.creations.list", undefined, {
          strategy: "network-only",
        }),
      );
  const inherited = [];
  for (const input of origins) {
    signal.throwIfAborted();
    if (input === null) continue;
    const origin = await verifyCreationOrigin(input, history.authority);
    if (
      origin.tenant !== permissions.tenant ||
      origin.capability.generation !== history.current.generation ||
      (domain && origin.id !== domain)
    )
      throw new InvalidProtectedData();
    inherited.push(...creationRules(origin));
  }
  signal.throwIfAborted();
  return { ...permissions, rules: [...permissions.rules, ...inherited] };
}

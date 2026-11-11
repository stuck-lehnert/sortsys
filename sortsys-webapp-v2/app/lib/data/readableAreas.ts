import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, policy, policyFrame, record, verify } from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { createdAccess } from "../crypto/createdAccess";
import { required } from "./protectedObjects";
import type { Collection } from "./protectedObjects";

/** Domain inventory is technical metadata, including for administrators. A
 * verified policy and a certified creation proof must still allow each read. */
export async function readableAreas(client: Client, signal: AbortSignal, select: (domain: string) => Collection | null): Promise<Collection[]> {
  const account = unlockedAccount(); if (!account) throw new InvalidProtectedData();
  const live = () => { signal.throwIfAborted(); if (unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const history = await trustedHistory(client), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw;
  let permissions = policy(unsigned);
  if (permissions.tenant !== account.tenant || typeof signature !== "string") throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  permissions = await createdAccess(client, permissions, history, signal); live();
  const allowed = new Set<string>(), denied = new Set<string>();
  for (const rule of permissions.rules) if (rule.subject === `user:${session.user.id}` && rule.actions.includes("read"))
    (rule.effect === "deny" ? denied : allowed).add(`${rule.scope}\0${rule.facet}`);
  const domains = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" })); live();
  const result: Collection[] = [];
  for (const domain of domains) {
    const area = select(domain.id); if (!area) continue;
    if (domain.scope !== area.scope || domain.facet !== area.facet || domain.id !== area.domain) throw new InvalidProtectedData();
    const key = `${area.scope}\0${area.facet}`;
    if (allowed.has(key) && !denied.has(key)) result.push(area);
  }
  if (result.length > 2000) throw new InvalidProtectedData();
  return result;
}

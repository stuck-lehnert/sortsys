import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, policy, policyFrame, record, verify } from "@sortsys/zerotrust";
import { createdAccess } from "../crypto/createdAccess";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { required } from "./protectedObjects";
import { fileDomainId, fileCollection } from "./projectFileData";

export async function readableFileAreas(client: Client, signal: AbortSignal): Promise<string[]> {
  const account = unlockedAccount(); if (!account) throw new InvalidProtectedData();
  const history = await trustedHistory(client), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" }));
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw; let permissions = policy(unsigned);
  if (typeof signature !== "string" || permissions.tenant !== account.tenant) throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions));
  permissions = await createdAccess(client, permissions, history, signal);
  const allowed = new Set<string>(), denied = new Set<string>();
  for (const rule of permissions.rules) if (rule.subject === `user:${session.user.id}` && rule.facet === "attachment" && rule.actions.includes("read")) (rule.effect === "deny" ? denied : allowed).add(rule.scope);
  const domains = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" })); signal.throwIfAborted();
  if (unlockedAccount() !== account) throw new InvalidProtectedData();
  const ids: string[] = [];
  for (const domain of domains) {
    const id = fileDomainId(domain.id); if (!id) continue;
    if (domain.scope !== fileCollection(id).scope || domain.facet !== "attachment") throw new InvalidProtectedData();
    if (allowed.has(domain.scope) && !denied.has(domain.scope)) ids.push(id);
  }
  if (ids.length > 2000) throw new InvalidProtectedData(); return ids;
}

import type { Client } from "@sortsys/v2-client";
import {
  compilePolicy,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../crypto/accessContext";
import { unlockedAccount } from "../crypto/session";
import { canUseAssistant, privateLlmCollection } from "./assistantArea";
import { protectedCollection, type Collection } from "./protectedObjects";

function assistantSession(client: Client, signal: AbortSignal) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const area = privateLlmCollection(account.vault.subject);
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  live();
  return { account, area, subject: account.vault.subject, live };
}

/** Both histories belong to the immutable vault principal. Reading them needs
 * their encrypted area's permission, not a second technical role assignment. */
export async function openAssistantCollection(
  client: Client,
  signal: AbortSignal,
  prefix?: string,
) {
  const session = assistantSession(client, signal);
  const collection = await protectedCollection(
    client,
    { ...session.area, ...(prefix === undefined ? {} : { prefix }) },
    signal,
  );
  try {
    session.live();
    return { ...session, collection };
  } catch (error) {
    collection.close();
    throw error;
  }
}

/** Running a model also needs permission to save its private result. Catalogue
 * and price permissions remain independent of that personal request right. */
export async function readAssistantAccess(
  client: Client,
  signal: AbortSignal,
  domains: readonly string[] | "inventory" = [],
) {
  const session = assistantSession(client, signal);
  const context = await verifiedAccessContext(
    client,
    signal,
    domains === "inventory"
      ? {}
      : { domains: [...new Set([session.area.domain, ...domains])] },
  );
  session.live();
  const privateArea = context.domains.find(
    (domain) => domain.id === session.area.domain,
  );
  const access = compilePolicy(context.permissions, [context.subject]);
  if (
    context.account !== session.account ||
    !privateArea ||
    privateArea.rotationRequired ||
    privateArea.scope !== session.area.scope ||
    privateArea.facet !== session.area.facet ||
    !canUseAssistant(context.subject, access.allows)
  )
    throw new InvalidProtectedData();
  const domainById = new Map(context.domains.map((domain) => [domain.id, domain]));
  function canRead(area: Collection) {
    const domain = domainById.get(area.domain);
    return (
      domain !== undefined &&
      !domain.rotationRequired &&
      domain.scope === area.scope &&
      domain.facet === area.facet &&
      access.allows(area.scope, area.facet, "read")
    );
  }
  return { ...session, allows: access.allows, domains: context.domains, canRead };
}

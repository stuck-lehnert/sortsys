import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { trustedHistory, unlockedAccount } from "./session";
import { openAuthority } from "./setup";
import { verifiedAccessContext } from "./accessContext";

/** Administration needs both a live technical role and possession of the
 * pinned tenant authority. Neither an API-supplied user ID nor a role suffices. */
export async function administratorContext(
  client: Client,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  live();
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  live();
  if (
    !session.roles.includes(":admin") ||
    account.vault.subject !== `user:${session.user.id}`
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  live();
  const identity = history.identityCertificate(`user:${session.user.id}`);
  if (
    identity.signingKey !== account.vault.signingKey ||
    identity.encryptionKey !== account.vault.encryptionKey
  )
    throw new InvalidProtectedData();
  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  live();
  const authority = await openAuthority(client, status.profile);
  live();
  return { account, session, history, authority, live };
}

/** Administrative operations use the same freshly checked public inventory as
 * ordinary reads, including certified creation grants and conditional pages. */
export async function administratorPolicyContext(
  client: Client,
  signal: AbortSignal,
  domains?: readonly string[],
) {
  const context = await administratorContext(client, signal);
  const selected = domains ? [...new Set(domains)] : [];
  const verified = await verifiedAccessContext(
    client,
    signal,
    selected.length > 0 && selected.length <= 16 ? { domains: selected } : {},
  );
  context.live();
  if (
    verified.account !== context.account ||
    verified.subject !== `user:${context.session.user.id}`
  )
    throw new InvalidProtectedData();
  return {
    ...context,
    history: verified.history,
    permissions: verified.rootPolicy,
    effective: verified.permissions,
    domains: verified.domains,
  };
}

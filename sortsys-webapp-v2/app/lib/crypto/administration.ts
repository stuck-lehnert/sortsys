import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { trustedHistory, unlockedAccount } from "./session";
import { openVerifiedAuthority } from "./setup";
import { verifiedAccessContext } from "./accessContext";

async function administratorSession(client: Client, signal: AbortSignal) {
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
  return { account, session, live };
}

function readTenantStatus(client: Client) {
  return required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
}

/** Check possession of the pinned tenant authority after the role check. */
async function confirmAdministrator(
  context: Awaited<ReturnType<typeof administratorSession>>,
  history: Awaited<ReturnType<typeof trustedHistory>>,
  profile: unknown,
) {
  const { account, session, live } = context;
  live();
  const identity = history.identityCertificate(`user:${session.user.id}`);
  if (
    identity.signingKey !== account.vault.signingKey ||
    identity.encryptionKey !== account.vault.encryptionKey
  )
    throw new InvalidProtectedData();
  const authority = await openVerifiedAuthority(profile, account, history);
  live();
  return { ...context, history, authority };
}

export async function administratorContext(
  client: Client,
  signal: AbortSignal,
) {
  const context = await administratorSession(client, signal);
  const [history, status] = await Promise.all([
    trustedHistory(client),
    readTenantStatus(client),
  ]);
  return confirmAdministrator(context, history, status.profile);
}

/** Administrative operations use the same freshly checked public inventory as
 * ordinary reads, including certified creation grants and conditional pages. */
export async function administratorPolicyContext(
  client: Client,
  signal: AbortSignal,
  domains?: readonly string[],
) {
  const context = await administratorSession(client, signal);
  const selected = domains ? [...new Set(domains)] : [];
  const [verified, status] = await Promise.all([
    verifiedAccessContext(
      client,
      signal,
      selected.length > 0 && selected.length <= 16 ? { domains: selected } : {},
    ),
    readTenantStatus(client),
  ]);
  context.live();
  if (
    verified.account !== context.account ||
    verified.subject !== `user:${context.session.user.id}`
  )
    throw new InvalidProtectedData();
  const administrator = await confirmAdministrator(
    context,
    verified.history,
    status.profile,
  );
  return {
    ...administrator,
    permissions: verified.rootPolicy,
    policySignature: verified.rootPolicySignature,
    inventorySnapshot: verified.snapshot,
    effective: verified.permissions,
    domains: verified.domains,
    origins: verified.origins,
  };
}

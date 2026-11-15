import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { trustedHistory, unlockedAccount } from "./session";
import { openAuthority } from "./setup";

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
    session.user.username !== account.username
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

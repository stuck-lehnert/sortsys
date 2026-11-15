import type { Client, QueryInput } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { unlockedAccount, verifyAccountHistory } from "./session";
import { verifyPolicySnapshot } from "./policy";
import { verifyCreatedAccess } from "./createdAccess";

/** One server transaction supplies public metadata, never an authorization
 * verdict to trust blindly. The browser verifies pins, the current identity,
 * policy and creation proofs before any content key can be requested. */
export async function verifiedAccessContext(
  client: Client,
  signal: AbortSignal,
  options: QueryInput<"zerotrust.access.snapshot"> = {},
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  live();
  const input = await required(
    client.query("zerotrust.access.snapshot", options, {
      strategy: "network-only",
    }),
  );
  live();
  record(input, [
    "subject",
    "username",
    "history",
    "policy",
    "origins",
    "domains",
  ]);
  if (input.username !== account.username) throw new InvalidProtectedData();
  if (typeof input.subject !== "string" || !Array.isArray(input.domains))
    throw new InvalidProtectedData();
  let selected: ReadonlySet<string> | undefined;
  if (options.domain !== undefined) {
    selected = new Set([options.domain]);
  } else if (options.domains !== undefined) {
    selected = new Set(options.domains);
  }
  const returned = new Set<string>();
  for (const domain of input.domains) {
    if (
      typeof domain.id !== "string" ||
      returned.has(domain.id) ||
      (selected && !selected.has(domain.id)) ||
      options.includeDomains === false
    )
      throw new InvalidProtectedData();
    returned.add(domain.id);
  }
  const history = await verifyAccountHistory(input.history, account);
  live();
  const identity = history.identityCertificate(input.subject);
  if (
    identity.encryptionKey !== account.vault.encryptionKey ||
    identity.signingKey !== account.vault.signingKey
  )
    throw new InvalidProtectedData();
  const { permissions: rootPolicy } = await verifyPolicySnapshot(input.policy, {
    account,
    history,
    live,
  });
  const permissions = await verifyCreatedAccess(
    input.origins,
    rootPolicy,
    history,
    signal,
    selected,
  );
  live();
  return {
    account,
    history,
    subject: input.subject,
    rootPolicy,
    permissions,
    domains: input.domains,
    live,
  };
}

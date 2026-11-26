import type { Client } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  unbase64,
  verifyInitializationSource,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import {
  trustedHistory,
  unlockedAccount,
  type UnlockedAccount,
} from "./session";

export async function readInitializationSource(
  client: Client,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();

  signal.throwIfAborted();
  const history = await trustedHistory(client);
  return readVerifiedInitializationSource(client, signal, account, history);
}

/** The caller supplies the history verified for this operation. The backup
 * state is still read from the server and checked against that history. */
export async function readVerifiedInitializationSource(
  client: Client,
  signal: AbortSignal,
  account: UnlockedAccount,
  history: Awaited<ReturnType<typeof trustedHistory>>,
) {
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  live();

  const context = history.current.context;
  if (context === undefined) return null;

  if (
    !context.startsWith("backup:") ||
    unbase64(context.slice(7), 32).length !== 32
  )
    throw new InvalidProtectedData();
  const state = await required(
    client.query("zerotrust.setup.backup.status", undefined, {
      strategy: "network-only",
    }),
  );
  live();
  if (state.context !== context) throw new InvalidProtectedData();
  const expected = {
    tenant: account.tenant,
    context,
    authority: history.authority,
  };
  const source = state.source
    ? await verifyInitializationSource(state.source, expected)
    : null;
  const completion = state.completion
    ? await verifyInitializationSource(state.completion, expected)
    : null;
  live();
  if (
    source &&
    (source.sourceSignature !== undefined ||
      source.manifest !== `${context}:manifest`)
  )
    throw new InvalidProtectedData();
  if (
    completion &&
    (!source ||
      completion.sourceSignature !== source.signature ||
      completion.manifest !== `${context}:receipt`)
  )
    throw new InvalidProtectedData();
  return { context, source, completion };
}

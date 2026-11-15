import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  attestMigrationOrigin,
  InvalidProtectedData,
  type HistoryOrigin,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "./session";
import { openAuthority } from "./setup";
import { required } from "../data/protectedObjects";
import { readInitializationSource } from "./initializationSource";

/** Shared by the ordinary source copier and conversions with atomic cross-area
 * publications. The authority key remains in the browser. */
export async function migrationOriginAttester(
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
  const history = await trustedHistory(client);
  live();
  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  live();
  const source = await readInitializationSource(client, signal);
  live();
  if (!source?.source || source.completion || status.initialization)
    throw new InvalidProtectedData();
  const authority = await openAuthority(client, status.profile);
  live();
  return async (
    packet: MutateInput<"zerotrust.objects.save">,
    origin?: HistoryOrigin,
  ) => {
    live();
    const migrationOrigin = await attestMigrationOrigin(
      packet.envelope,
      history.current.generation,
      authority,
      origin,
    );
    live();
    return { ...packet, migrationOrigin };
  };
}

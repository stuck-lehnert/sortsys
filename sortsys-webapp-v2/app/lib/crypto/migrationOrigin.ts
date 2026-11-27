import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  attestMigrationOrigin,
  InvalidProtectedData,
  type HistoryOrigin,
} from "@sortsys/zerotrust/sortsys";
import { captureAccountScope, trustedHistory } from "./session";
import { openVerifiedAuthority } from "./setup";
import { required } from "../data/protectedObjects";
import { readVerifiedInitializationSource } from "./initializationSource";

/** Shared by the ordinary source copier and conversions with atomic cross-area
 * publications. The authority key remains in the browser. */
export async function migrationOriginAttester(
  client: Client,
  signal: AbortSignal,
) {
  const { account, live } = captureAccountScope(signal, client);
  live();

  const history = await trustedHistory(client);
  live();

  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  live();

  const source = await readVerifiedInitializationSource(
    client,
    signal,
    account,
    history,
  );
  live();
  if (!source?.source || source.completion || status.initialization)
    throw new InvalidProtectedData();

  const authority = await openVerifiedAuthority(
    status.profile,
    account,
    history,
  );
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

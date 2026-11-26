import type { Client } from "@sortsys/v2-client";
import { mapConcurrent } from "@sortsys/zerotrust";
import {
  InvalidProtectedData,
  verifyMigrationOrigin,
} from "@sortsys/zerotrust/sortsys";
import type { LegacyActivityPart } from "./legacyActivityData";
import { required } from "./protectedObjects";

type ActivityCopy = {
  domain: string;
  item: Pick<LegacyActivityPart, "id" | "source" | "occurredMicros">;
};

/** A matching row alone does not prove that the original action was kept.
 * Check the original revision and its authority evidence, including on replay. */
export async function verifyActivityCopies(
  client: Pick<Client, "query">,
  copies: readonly ActivityCopy[],
  authority: (generation: string) => CryptoKey,
  live: () => void,
) {
  await mapConcurrent(copies, 16, async ({ domain, item }) => {
    live();
    const stored = await required(
      client.query(
        "zerotrust.history.get",
        { id: item.id, revision: "1" },
        { strategy: "network-only" },
      ),
    );
    live();

    const proof = await verifyMigrationOrigin(
      stored.envelope,
      stored.migrationOrigin,
      authority,
    );
    live();

    if (
      stored.domain !== domain ||
      stored.envelope.object !== item.id ||
      proof.history?.source !== item.source ||
      proof.history.occurredMicros !== item.occurredMicros ||
      stored.occurredMicros !== item.occurredMicros
    ) {
      throw new InvalidProtectedData();
    }
  });
}

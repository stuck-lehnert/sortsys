import type { Client } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  verifyMigrationOrigin,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import type { BusinessDatabase } from "./database";
import { readBusinessRows } from "./products";
import { RESOURCE_TYPES } from "./activityData";
import {
  LEGACY_ACTIVITY_PREFIX,
  legacyActivity,
  splitLegacyActivity,
  type LegacyActivityPart,
} from "./legacyActivityData";
import { prepareOwnerCollections } from "./prepareCollections";
import { copyProtectedCollection } from "./copyCollection";
import { protectedCollections, required } from "./protectedObjects";

/** Convert the frozen original feed, including deleted entities and actors.
 * Ordinary source snapshots remain distinct from these actual past actions. */
export async function prepareActivities(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  const groups = new Map<string, LegacyActivityPart[]>();
  for (const row of await readBusinessRows(source, "entity_changes")) {
    live();
    // The old feed also excluded operational rows without a resource. They
    // remain in the authority's complete encrypted source archive.
    if (
      !RESOURCE_TYPES.includes(
        row.values.resource_type as (typeof RESOURCE_TYPES)[number],
      ) ||
      row.values.resource_id === null
    )
      continue;
    for (const part of splitLegacyActivity(row)) {
      const items = groups.get(part.area.domain) ?? [];
      items.push(part);
      groups.set(part.area.domain, items);
    }
  }
  await prepareOwnerCollections(
    client,
    subject,
    [...groups.values()].map((items) => items[0]!.area),
    signal,
  );
  live();
  const history = await trustedHistory(client);
  const open = await protectedCollections(client, signal);
  live();
  for (const items of groups.values()) {
    const area = {
      ...items[0]!.area,
      prefix: `${LEGACY_ACTIVITY_PREFIX}${items[0]!.area.domain}:`,
    };
    const byId = new Map(items.map((item) => [item.id, item]));
    await copyProtectedCollection(
      client,
      area,
      items,
      (value, id) => legacyActivity(value, id, area),
      signal,
      false,
      open,
      (_, id) => {
        const item = byId.get(id);
        if (!item) throw new InvalidProtectedData();
        return { source: item.source, occurredMicros: item.occurredMicros };
      },
    );
    // A replayed migration must retain the same authority evidence, too. A
    // matching body alone is insufficient when the API has omitted its origin.
    for (let index = 0; index < items.length; index += 16)
      await Promise.all(
        items.slice(index, index + 16).map(async (item) => {
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
            history.authority,
          );
          live();
          if (
            stored.domain !== area.domain ||
            stored.envelope.object !== item.id ||
            proof.history?.source !== item.source ||
            proof.history.occurredMicros !== item.occurredMicros ||
            stored.occurredMicros !== item.occurredMicros
          )
            throw new InvalidProtectedData();
        }),
      );
  }
}

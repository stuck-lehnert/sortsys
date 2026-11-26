import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
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
import { protectedCollections } from "./protectedObjects";
import { verifyActivityCopies } from "./verifyActivityCopies";

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
  for (const [domain, items] of groups) {
    live();

    const area = {
      ...items[0]!.area,
      prefix: `${LEGACY_ACTIVITY_PREFIX}${domain}:`,
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
  }

  live();
  const copies = [...groups].flatMap(([domain, items]) =>
    items.map((item) => ({ domain, item })),
  );
  await verifyActivityCopies(client, copies, history.authority, live);
}

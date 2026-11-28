import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { captureAccountScope, trustedHistory } from "../crypto/session";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { RESOURCE_TYPES } from "./activityData";
import {
  LEGACY_ACTIVITY_PREFIX,
  legacyActivity,
  splitLegacyActivity,
  type LegacyActivityPart,
} from "./legacyActivityData";
import { prepareOwnerCollections } from "./prepareCollections";
import { copyProtectedAreas, lazyCopyAttester } from "./copyCollection";
import { protectedCollections } from "./protectedObjects";
import { verifyActivityCopies } from "./verifyActivityCopies";

/** Convert the frozen original feed, including deleted entities and actors.
 * Ordinary source snapshots remain distinct from these actual past actions. */
export async function prepareActivities(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
  progress?: (phase: "provision" | "copy" | "verify") => void,
) {
  const { live } = captureAccountScope(signal);

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
  progress?.("provision");
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
  const attest = lazyCopyAttester(client, signal);
  const entries = [...groups.values()].map((items) => {
    const area = {
      ...items[0]!.area,
      prefix: `${LEGACY_ACTIVITY_PREFIX}${items[0]!.area.domain}:`,
    };
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      area,
      rows: items,
      validate: (value: unknown, id: string) => legacyActivity(value, id, area),
      attest(packet: Parameters<typeof attest>[0]) {
        const item = byId.get(packet.envelope.object);
        if (!item) throw new InvalidProtectedData();
        return attest(packet, {
          source: item.source,
          occurredMicros: item.occurredMicros,
        });
      },
    };
  });
  progress?.("copy");
  await copyProtectedAreas(client, entries, signal, open);

  progress?.("verify");
  // Share one bounded queue across areas. Even an unchanged copy must
  // retain its original authority evidence.
  const copies = entries.flatMap(({ area, rows }) =>
    rows.map((item) => ({ domain: area.domain, item })),
  );
  await verifyActivityCopies(client, copies, history.authority, live);
}

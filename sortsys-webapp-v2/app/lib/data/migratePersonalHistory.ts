import type { Client } from "@sortsys/v2-client";
import type { BusinessDatabase } from "./database";
import { readBusinessRows, publicId } from "./products";
import { prepareOwnerCollections } from "./prepareCollections";
import { copySmallProtectedCollections } from "./copyCollection";
import {
  historyCollection,
  historyObject,
  recentHistory,
  PERSONAL_HISTORY_MODEL,
  type HistoryKind,
  type PersonalPayload,
} from "./personalHistoryData";
import type { BusinessRow } from "./rowCodec";

/** Preserve the existing per-person retention bounds and microsecond order.
 * Nothing is copied to another employee's keys or sent to a plaintext RPC. */
export async function preparePersonalHistory(
  client: Client,
  source: BusinessDatabase,
  owner: string,
  signal: AbortSignal,
) {
  const values = new Map<string, Record<HistoryKind, BusinessRow[]>>();
  const own = (subject: string) => {
    let value = values.get(subject);
    if (!value) {
      value = { visits: [], actions: [] };
      values.set(subject, value);
    }
    return value;
  };
  own(owner);
  for (const user of await readBusinessRows(source, "users"))
    own(`user:${publicId(user.values.id)}`);
  for (const [table, kind] of [
    ["user_visit_history", "visits"],
    ["user_action_history", "actions"],
  ] as const) {
    for (const row of await readBusinessRows(source, table))
      own(`user:${publicId(row.values.user_id)}`)[kind].push(row);
  }
  await prepareOwnerCollections(
    client,
    owner,
    [...values.keys()].map(historyCollection),
    signal,
  );
  await copyPersonalHistory(client, values, signal);
}
export async function copyPersonalHistory(
  client: Client,
  values: ReadonlyMap<string, Record<HistoryKind, BusinessRow[]>>,
  signal: AbortSignal,
) {
  const copies = Array.from(values, ([subject, rows]) => {
    const area = historyCollection(subject);
    const entries = (["visits", "actions"] as const).map((kind) => ({
      id: historyObject(subject, kind),
      value: {
        format: "sortsys-personal-history-v1",
        subject,
        kind,
        rows: recentHistory(rows[kind], kind),
      } satisfies PersonalPayload,
    }));
    return {
      area,
      rows: entries,
      validate: (value: unknown, id: string) =>
        PERSONAL_HISTORY_MODEL.decode(value, id, area),
      partial: true,
    };
  });

  await copySmallProtectedCollections(client, copies, signal);
}

import type { Client } from "@sortsys/v2-client";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import {
  remarkCollection,
  remarkObject,
  remarkPayload,
  remarkResourceFromRow,
  type RemarkPayload,
} from "./remarkData";
import type { Collection } from "./protectedObjects";
import type { BusinessRow } from "./rowCodec";

export async function copyRemarks(
  client: Client,
  rows: readonly BusinessRow[],
  signal: AbortSignal,
) {
  const groups = new Map<
    string,
    { area: Collection; entries: { id: string; value: RemarkPayload }[] }
  >();
  for (const row of rows) {
    const area = remarkCollection(remarkResourceFromRow(row));
    const id = remarkObject(row.values.id);
    const value = remarkPayload({ format: "sortsys-remark-v1", row }, id, area);
    let group = groups.get(area.domain);
    if (!group) {
      group = { area, entries: [] };
      groups.set(area.domain, group);
    }
    group.entries.push({ id, value });
  }
  for (const { area, entries } of groups.values()) {
    await copyProtectedCollection(
      client,
      area,
      entries,
      (value, object) => remarkPayload(value, object, area),
      signal,
    );
  }
}

export async function prepareRemarks(
  client: Client,
  source: BusinessDatabase,
  owner: string,
  signal: AbortSignal,
) {
  const rows = await readBusinessRows(source, "resource_notes");
  signal.throwIfAborted();
  const areas = new Map(
    rows.map((row) => {
      const area = remarkCollection(remarkResourceFromRow(row));
      return [area.domain, area];
    }),
  );
  await prepareOwnerCollections(client, owner, [...areas.values()], signal);
  await copyRemarks(client, rows, signal);
}

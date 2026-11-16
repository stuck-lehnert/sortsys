import type { Client } from "@sortsys/v2-client";
import { prepareToolUsage } from "./migrateToolUsage";
import {
  CREATION_FACETS,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import {
  toolCollection,
  toolPart,
  bookingToolSummary,
  TOOL_INDEX,
  TOOL_INDEX_MODEL,
  TOOL_MODEL,
  type ToolIndex,
} from "./toolData";
import type { BusinessRow } from "./rowCodec";
import { protectedCollections } from "./protectedObjects";

export async function prepareTools(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const tools = await readBusinessRows(source, "tools"),
    trackings = await readBusinessRows(source, "tool_trackings"),
    inventories = await readBusinessRows(source, "tool_inventories"),
    transfers = await readBusinessRows(
      source,
      "tool_tracking_transfer_requests",
    );
  const inventoryByTool = new Map<string, BusinessRow[]>(),
    transfersByTracking = new Map<string, BusinessRow[]>(),
    active = new Map<string, string>();
  const toolsById = new Map(tools.map((row) => [row.values.id, row]));
  for (const row of inventories) {
    const key = row.values.tool_id as string,
      rows = inventoryByTool.get(key) ?? [];
    rows.push(row);
    inventoryByTool.set(key, rows);
  }
  for (const row of transfers) {
    const key = row.values.tool_tracking_id as string,
      rows = transfersByTracking.get(key) ?? [];
    rows.push(row);
    transfersByTracking.set(key, rows);
  }
  for (const row of trackings)
    if (row.values.ended_at === null) {
      const key = row.values.tool_id as string;
      if (active.has(key)) throw new InvalidProtectedData();
      active.set(key, publicId(row.values.id));
    }
  const areas = [
    TOOL_INDEX,
    ...tools.flatMap((row) =>
      CREATION_FACETS.tool.map((facet) =>
        toolCollection("tool", publicId(row.values.id), facet),
      ),
    ),
    ...trackings.flatMap((row) =>
      CREATION_FACETS["tool-tracking"].map((facet) =>
        toolCollection("tool-tracking", publicId(row.values.id), facet),
      ),
    ),
  ];
  await prepareOwnerCollections(client, subject, areas, signal);
  const open = await protectedCollections(client, signal);
  const index: ToolIndex = {
    format: "sortsys-tool-index-v1",
    entries: tools.map((row) => ({
      id: publicId(row.values.id),
      customId: Number(row.values.custom_id),
    })),
  };
  await copyProtectedCollection(
    client,
    TOOL_INDEX,
    [{ id: TOOL_INDEX.prefix, value: index }],
    (value, object) => TOOL_INDEX_MODEL.decode(value, object, TOOL_INDEX),
    signal,
    false,
    open,
  );
  for (const row of tools)
    for (const facet of CREATION_FACETS.tool) {
      const id = publicId(row.values.id),
        area = toolCollection("tool", id, facet),
        rows = [row, ...(inventoryByTool.get(row.values.id as string) ?? [])];
      const value = toolPart(
        "tool",
        id,
        facet,
        rows,
        facet === "master-data"
          ? (active.get(row.values.id as string) ?? null)
          : null,
      );
      await copyProtectedCollection(
        client,
        area,
        [{ id: area.prefix, value }],
        (value, object) => TOOL_MODEL.decode(value, object, area),
        signal,
        false,
        open,
      );
    }
  for (const row of trackings)
    for (const facet of CREATION_FACETS["tool-tracking"]) {
      const id = publicId(row.values.id),
        area = toolCollection("tool-tracking", id, facet),
        value = toolPart(
          "tool-tracking",
          id,
          facet,
          [row, ...(transfersByTracking.get(row.values.id as string) ?? [])],
          null,
          toolsById.has(row.values.tool_id)
            ? bookingToolSummary(toolsById.get(row.values.tool_id)!)
            : undefined,
        );
      await copyProtectedCollection(
        client,
        area,
        [{ id: area.prefix, value }],
        (value, object) => TOOL_MODEL.decode(value, object, area),
        signal,
        false,
        open,
      );
    }
  await prepareToolUsage(client, source, subject, signal);
}

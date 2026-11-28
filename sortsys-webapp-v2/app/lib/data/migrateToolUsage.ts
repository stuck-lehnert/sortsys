import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId } from "./products";
import {
  TOOL_USAGE_FACETS,
  TOOL_USAGE_MODEL,
  toolUsageCollection,
  toolUsagePart,
} from "./projectToolUsage";

export async function prepareToolUsage(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const projects = await readBusinessRows(source, "projects");
  const trackings = await readBusinessRows(source, "tool_trackings");
  const ids = new Set(projects.map((project) => project.values.id));
  if (
    trackings.some(
      (row) =>
        row.values.project_id !== null && !ids.has(row.values.project_id),
    )
  ) {
    throw new InvalidProtectedData();
  }
  const areas = projects.flatMap((project) =>
    TOOL_USAGE_FACETS.map((facet) =>
      toolUsageCollection(publicId(project.values.id), facet),
    ),
  );
  await prepareOwnerCollections(client, subject, areas, signal);
  for (const project of projects) {
    for (const facet of TOOL_USAGE_FACETS) {
      const area = toolUsageCollection(publicId(project.values.id), facet);
      const payloads = trackings
        .filter((row) => row.values.project_id === project.values.id)
        .map((row) => ({
          id: area.prefix + publicId(row.values.id),
          value: toolUsagePart(row, facet),
        }));
      await copyProtectedCollection(
        client,
        area,
        payloads,
        (input, object) => TOOL_USAGE_MODEL.decode(input, object, area),
        signal,
      );
    }
  }
}

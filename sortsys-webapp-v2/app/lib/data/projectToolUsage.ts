import { InvalidProtectedData, record, sized } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { publicId } from "./products";
import { projectModuleArea, projectModuleDomain } from "./projectScope";
import type { Collection } from "./protectedObjects";
import { decodeBusinessFields, type BusinessFields } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import type { DataTransaction } from "./runtime/runtime";
import { tableDefinition } from "./schema";

export const TOOL_USAGE_FACETS = ["master-data", "procurement"] as const;
export type ToolUsageFacet = (typeof TOOL_USAGE_FACETS)[number];
export type ToolUsage = {
  format: "sortsys-project-tool-usage-v1";
  projectId: string;
  facet: ToolUsageFacet;
  tracking: BusinessFields;
  returnKey?: string;
};

export function toolUsageCollection(
  projectId: string,
  facet: ToolUsageFacet,
): Collection {
  return {
    ...projectModuleArea(projectId, "tool-usage", facet),
    prefix: `tool-usage:${projectId}:${facet}:`,
  };
}
export function toolUsageDomain(
  domain: string,
): { projectId: string; facet: ToolUsageFacet } | null {
  const part = projectModuleDomain(domain);
  if (
    part?.module !== "tool-usage" ||
    !TOOL_USAGE_FACETS.includes(part.facet as ToolUsageFacet)
  )
    return null;
  return { projectId: part.id, facet: part.facet as ToolUsageFacet };
}
function trackingColumns(facet: ToolUsageFacet): string[] {
  if (facet === "procurement")
    return ["id", "project_id", "tool_usage_cost_per_day"];
  return tableDefinition("tool_trackings")
    .columns.map((column) => column.name)
    .filter((name) => name !== "tool_usage_cost_per_day");
}
export function trackingProject(tracking: BusinessFields): string | null {
  if (tracking.table !== "tool_trackings") throw new InvalidProtectedData();
  if (tracking.values.project_id === null) return null;
  const id = publicId(tracking.values.project_id);
  addressId(id);
  return id;
}
export function toolUsagePart(
  tracking: BusinessFields,
  facet: ToolUsageFacet,
  returnKey?: string,
): ToolUsage {
  const projectId = trackingProject(tracking);
  if (!projectId) throw new InvalidProtectedData();
  const fields = trackingColumns(facet);
  const selected = Object.fromEntries(
    fields.map((name) => [name, tracking.values[name]]),
  );
  return {
    format: "sortsys-project-tool-usage-v1",
    projectId,
    facet,
    tracking: decodeBusinessFields("tool_trackings", selected),
    ...(facet === "master-data" && returnKey ? { returnKey } : {}),
  };
}
export const TOOL_USAGE_MODEL = defineDataModel<ToolUsage>({
  name: "project-tool-usage",
  // The source tracking owns the SQL row. This project projection deliberately
  // has no second writable owner for those same cells in the shared runtime.
  tables: [],
  sources: () => [],
  decode(input, object, area) {
    const payload = partialAddressRecord(input, [
      "format", "projectId", "facet", "tracking", "returnKey",
    ]);
    const part = toolUsageDomain(area.domain);
    if (
      !part ||
      payload.format !== "sortsys-project-tool-usage-v1" ||
      payload.projectId !== part.projectId ||
      payload.facet !== part.facet
    )
      throw new InvalidProtectedData();
    const returnKey = payload.returnKey;
    if (returnKey !== undefined) {
      if (part.facet !== "master-data" || typeof returnKey !== "string")
        throw new InvalidProtectedData();
      sized(returnKey, 32);
    }
    const expected = toolUsageCollection(part.projectId, part.facet);
    if (
      area.scope !== expected.scope ||
      area.facet !== expected.facet ||
      area.prefix !== expected.prefix
    ) {
      throw new InvalidProtectedData();
    }
    const row = record(payload.tracking, ["table", "values"]);
    if (row.table !== "tool_trackings") throw new InvalidProtectedData();
    const values = record(row.values, trackingColumns(part.facet));
    const tracking = decodeBusinessFields("tool_trackings", values);
    const id = publicId(tracking.values.id);
    addressId(id);
    if (
      trackingProject(tracking) !== part.projectId ||
      object !== expected.prefix + id
    )
      throw new InvalidProtectedData();
    const rate = tracking.values.tool_usage_cost_per_day;
    if (
      part.facet === "procurement" &&
      rate !== null &&
      (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
    )
      throw new InvalidProtectedData();
    return {
      format: payload.format,
      projectId: part.projectId,
      facet: part.facet,
      tracking,
      ...(returnKey === undefined ? {} : { returnKey }),
    };
  },
});
export function toolUsageRequest(projectId: string, facet: ToolUsageFacet) {
  return {
    model: TOOL_USAGE_MODEL,
    area: toolUsageCollection(projectId, facet),
  };
}
export function toolUsageRequests(
  tracking: BusinessFields,
  facets: readonly ToolUsageFacet[] = TOOL_USAGE_FACETS,
) {
  const projectId = trackingProject(tracking);
  return projectId
    ? facets.map((facet) => toolUsageRequest(projectId, facet))
    : [];
}
export function syncToolUsage(
  transaction: DataTransaction,
  tracking: BusinessFields,
  facets: readonly ToolUsageFacet[] = TOOL_USAGE_FACETS,
  returnKey?: string,
) {
  for (const request of toolUsageRequests(tracking, facets)) {
    const object = request.area.prefix + publicId(tracking.values.id);
    const previous = transaction
      .documents(request)
      .find((document) => document.id === object);
    if (
      request.area.facet === "master-data" &&
      previous &&
      previous.value.returnKey !== returnKey
    ) throw new InvalidProtectedData();
    const value = toolUsagePart(
      tracking,
      request.area.facet as ToolUsageFacet,
      returnKey,
    );
    if (previous) {
      transaction.require(request, "update");
      transaction.edit(request, object, (current) =>
        Object.assign(current, value),
      );
    } else {
      transaction.require(request, "create");
      transaction.create(request, object, value);
    }
  }
}
export function deleteToolUsage(
  transaction: DataTransaction,
  tracking: BusinessFields,
) {
  for (const request of toolUsageRequests(tracking)) {
    const object = request.area.prefix + publicId(tracking.values.id);
    const previous = transaction
      .documents(request)
      .find((document) => document.id === object);
    if (!previous) throw new InvalidProtectedData();
    transaction.delete(request, object);
  }
}

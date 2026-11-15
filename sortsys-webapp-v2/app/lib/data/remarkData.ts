import type { QueryInput, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import {
  addressId,
  CONTACT_COLLECTION,
  CONTACT_MODEL,
  CUSTOMER_COLLECTION,
  CUSTOMER_MODEL,
} from "./addressBook";
import {
  PROJECT_MODEL,
  projectCollection,
  projectDomainId,
} from "./projectData";
import { publicId } from "./products";
import type { Collection } from "./protectedObjects";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import type { DataRequest, DataView } from "./runtime/runtime";
import { timestampMicros } from "./timestamps";
import { TOOL_MODEL, toolCollection, toolDomain } from "./toolData";

export type RemarkResource = QueryInput<"remarks.list">;
export type RemarkKind = RemarkResource["resourceType"];
export type RemarkPayload = { format: "sortsys-remark-v1"; row: BusinessRow };
export const REMARK_PREFIX = "remark:";
export const REMARK_QUERIES = new Set(["remarks.list"]);
export const REMARK_MUTATIONS = new Set([
  "remarks.create",
  "remarks.update",
  "remarks.delete",
]);
const RESOURCE_COLUMNS = {
  project: "project_id",
  customer: "customer_id",
  tool: "tool_id",
  contact: "contact_id",
} as const;

export function remarkResource(input: unknown): RemarkResource {
  const value = record(input, ["resourceType", "resourceId"]);
  if (
    typeof value.resourceType !== "string" ||
    !Object.hasOwn(RESOURCE_COLUMNS, value.resourceType)
  ) {
    throw new InvalidProtectedData();
  }
  addressId(value.resourceId);
  return {
    resourceType: value.resourceType as RemarkKind,
    resourceId: value.resourceId as string,
  };
}

export function remarkResourceFromRow(row: BusinessRow): RemarkResource {
  if (row.table !== "resource_notes") throw new InvalidProtectedData();
  const targets = Object.entries(RESOURCE_COLUMNS).filter(
    ([, column]) => row.values[column] !== null,
  );
  if (targets.length !== 1) throw new InvalidProtectedData();
  const [resourceType, column] = targets[0]!;
  return remarkResource({
    resourceType,
    resourceId: publicId(row.values[column]),
  });
}

export function remarkObject(rawId: unknown): string {
  const id = publicId(rawId);
  addressId(id);
  return REMARK_PREFIX + id;
}

export function remarkBody(input: unknown): string {
  if (typeof input !== "string" || input.includes("\0"))
    throw new InvalidProtectedData();
  const text = input.trim();
  if (!text || new TextEncoder().encode(text).length > 10000)
    throw new InvalidProtectedData();
  return text;
}

function resourceArea(resource: RemarkResource): Collection {
  switch (resource.resourceType) {
    case "project":
      return projectCollection(resource.resourceId);
    case "customer":
      return CUSTOMER_COLLECTION;
    case "contact":
      return CONTACT_COLLECTION;
    case "tool":
      return toolCollection("tool", resource.resourceId, "master-data");
  }
}

/** Notes use their parent's existing content key. A catalogue key is never
 * substituted for the independent key of a project or an individual tool. */
export function remarkCollection(resource: RemarkResource): Collection {
  remarkResource(resource);
  return { ...resourceArea(resource), prefix: REMARK_PREFIX };
}

export function remarkAreaFromScope(scope: string): Collection {
  if (scope === CUSTOMER_COLLECTION.scope)
    return { ...CUSTOMER_COLLECTION, prefix: REMARK_PREFIX };
  if (scope === CONTACT_COLLECTION.scope)
    return { ...CONTACT_COLLECTION, prefix: REMARK_PREFIX };
  const project = projectDomainId(`${scope}:master-data`);
  if (project)
    return remarkCollection({ resourceType: "project", resourceId: project });
  const tool = toolDomain(`${scope}:master-data`);
  if (tool?.namespace === "tool" && tool.facet === "master-data") {
    return remarkCollection({ resourceType: "tool", resourceId: tool.id });
  }
  throw new InvalidProtectedData();
}

export function remarkDomain(domain: string): boolean {
  if (
    domain === CUSTOMER_COLLECTION.domain ||
    domain === CONTACT_COLLECTION.domain
  )
    return true;
  if (projectDomainId(domain)) return true;
  const tool = toolDomain(domain);
  return tool?.namespace === "tool" && tool.facet === "master-data";
}

export function remarkPayload(
  input: unknown,
  object: string,
  area: Collection,
): RemarkPayload {
  const value = record(input, ["format", "row"]);
  const row = decodeBusinessRow(value.row);
  if (
    value.format !== "sortsys-remark-v1" ||
    object !== remarkObject(row.values.id)
  )
    throw new InvalidProtectedData();
  const expected = remarkCollection(remarkResourceFromRow(row));
  if (
    area.domain !== expected.domain ||
    area.scope !== expected.scope ||
    area.facet !== expected.facet ||
    area.prefix !== REMARK_PREFIX
  ) {
    throw new InvalidProtectedData();
  }
  remarkBody(row.values.body);
  if (row.values.created_by_user_id !== null)
    addressId(publicId(row.values.created_by_user_id));
  return { format: value.format, row };
}

export const REMARK_MODEL = defineDataModel<RemarkPayload>({
  name: "remarks",
  tables: ["resource_notes"],
  externalReferences: ["users", "projects", "customers", "contacts", "tools"],
  decode: remarkPayload,
});
export const remarkRequest = (resource: RemarkResource) => ({
  model: REMARK_MODEL,
  area: remarkCollection(resource),
});

type RemarkParent = { request: DataRequest; check(view: DataView): void };
export function remarkParent(resource: RemarkResource): RemarkParent {
  const id = resource.resourceId;
  if (resource.resourceType === "project") {
    const area = projectCollection(id);
    const request = { model: PROJECT_MODEL, area, ids: [area.prefix] };
    return {
      request,
      check(view) {
        const exists = view
          .documents(request)
          .some((document) => document.value.project !== null);
        if (!exists) throw new InvalidProtectedData();
      },
    };
  }
  if (resource.resourceType === "tool") {
    const area = toolCollection("tool", id, "master-data");
    const request = { model: TOOL_MODEL, area, ids: [area.prefix] };
    return {
      request,
      check(view) {
        const exists = view
          .documents(request)
          .some((document) => !document.value.deleted);
        if (!exists) throw new InvalidProtectedData();
      },
    };
  }
  const customer = resource.resourceType === "customer";
  const area = customer ? CUSTOMER_COLLECTION : CONTACT_COLLECTION;
  const model = customer ? CUSTOMER_MODEL : CONTACT_MODEL;
  const request = { model, area, ids: [area.prefix + id] };
  return {
    request,
    check(view) {
      const exists = view
        .documents(request)
        .some((document) => document.value.row !== null);
      if (!exists) throw new InvalidProtectedData();
    },
  };
}

export function remarkValues(
  resource: RemarkResource,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(RESOURCE_COLUMNS).map(([kind, column]) => [
      column,
      kind === resource.resourceType ? addressId(resource.resourceId) : null,
    ]),
  );
}

export function compareRemarksNewestFirst(
  left: RemarkPayload,
  right: RemarkPayload,
): number {
  const leftTime = timestampMicros(left.row.values.created_at as string);
  const rightTime = timestampMicros(right.row.values.created_at as string);
  if (leftTime > rightTime) return -1;
  if (leftTime < rightTime) return 1;
  const leftId = BigInt(left.row.values.id as string);
  const rightId = BigInt(right.row.values.id as string);
  if (leftId > rightId) return -1;
  if (leftId < rightId) return 1;
  return 0;
}

export function wireRemark(
  payload: RemarkPayload,
): QueryResult<"remarks.list">[number] {
  const fields = payload.row.values;
  return {
    id: publicId(fields.id),
    body: fields.body as string,
    createdByUserId:
      fields.created_by_user_id === null
        ? null
        : publicId(fields.created_by_user_id),
    createdAt: new Date(fields.created_at as string),
    modifiedAt: new Date(fields.modified_at as string),
  };
}

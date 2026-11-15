import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import {
  addressId,
  CUSTOMER_COLLECTION,
  CONTACT_COLLECTION,
} from "./addressBook";
import { PRODUCT_COLLECTION, PRICE_COLLECTION, publicId } from "./products";
import { VENDOR_COLLECTION } from "./vendorData";
import {
  personnelCollection,
  personnelColumns,
  PERSONNEL_FACETS,
} from "./personnelData";
import { projectCollection } from "./projectData";
import { fileCollection } from "./projectFileData";
import { dailyCollection } from "./dailyReportData";
import { regieCollection } from "./regieReportData";
import { deliveryCollection } from "./deliveryNoteData";
import { scheduleCollection } from "./projectScheduleData";
import { absenceCollection } from "./absenceData";
import { toolCollection } from "./toolData";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { timestampMicros } from "./timestamps";
import { RESOURCE_TYPES, type ResourceType } from "./activityData";
import type { Collection } from "./protectedObjects";

export const LEGACY_ACTIVITY_PREFIX = "legacy-activity:";
type Values = BusinessRow["values"];
export type LegacyEvent = {
  format: "sortsys-legacy-activity-v1";
  part: "event";
  row: BusinessRow;
};
type NamePart = "resource" | "context" | "actor";
export type LegacyName = {
  format: "sortsys-legacy-activity-v1";
  part: NamePart;
  source: string;
  resourceType: ResourceType | null;
  resourceId: string | null;
  entityTable: string | null;
  contextId: string | null;
  actorId: string | null;
  title: string | null;
  resourceTitle: string | null;
  contextTitle: string | null;
  actorName: string | null;
};
export type LegacyActivity = LegacyEvent | LegacyName;
export type LegacyActivityPart = {
  area: Collection;
  id: string;
  value: LegacyActivity;
  source: string;
  occurredMicros: string;
};

/** Events for not-yet-connected models stay encrypted in their own explicit
 * area. They must never inherit a broader master-data grant just for display. */
function isolated(values: Values, purpose: string): Collection {
  const scope = `history:${values.resource_type}:${publicId(values.resource_id)}:${purpose}`;
  return {
    scope,
    domain: `${scope}:scope`,
    facet: "scope",
    prefix: LEGACY_ACTIVITY_PREFIX,
  };
}
function project(values: Values): string {
  if (values.context_id === null) throw new InvalidProtectedData();
  return publicId(values.context_id);
}
function rootArea(values: Values): Collection {
  const id = publicId(values.resource_id);
  switch (values.resource_type) {
    case "project":
      return projectCollection(id);
    case "user":
      return personnelCollection(id, "master-data");
    case "tool":
      return toolCollection("tool", id, "master-data");
    case "customer":
      return CUSTOMER_COLLECTION;
    case "contact":
      return CONTACT_COLLECTION;
    case "product":
      return PRODUCT_COLLECTION;
    case "productVendor":
      return VENDOR_COLLECTION;
    case "deliveryNote":
      return values.context_id === null
        ? isolated(values, "delivery")
        : deliveryCollection(project(values));
    case "regieReport":
      return values.context_id === null
        ? isolated(values, "regie")
        : regieCollection(project(values));
    case "dailyProjectReport":
      return values.context_id === null
        ? isolated(values, "daily")
        : dailyCollection(project(values));
    default:
      throw new InvalidProtectedData();
  }
}

/** Column ownership mirrors the encrypted content models. Unknown historical
 * columns remain available to the authority, without granting them as names. */
function columnArea(values: Values, column: string): Collection {
  const table = values.entity_table;
  const id = publicId(values.resource_id);
  if (table === "users") {
    const facet = PERSONNEL_FACETS.find((facet) =>
      personnelColumns(facet).includes(column),
    );
    return facet ? personnelCollection(id, facet) : isolated(values, "account");
  }
  if (table === "product_price_records") return PRICE_COLLECTION;
  if (table === "user_vacations")
    return absenceCollection(
      id,
      ["status", "denial_reason", "decided_at", "decided_by_user_id"].includes(
        column,
      ),
    );
  if (["user_role_assignments", "user_passkeys"].includes(table as string))
    return isolated(values, "account");
  if (["project_files", "project_file_folders"].includes(table as string))
    return fileCollection(id);
  if (
    ["project_deployments", "project_unavailability_periods"].includes(
      table as string,
    )
  )
    return scheduleCollection(id);
  if (table === "project_financial_entries")
    return isolated(values, "financial-history");
  if (table === "daily_project_report_work_hours" && column === "cost_per_hour")
    return values.context_id === null
      ? isolated(values, "daily-costs")
      : dailyCollection(project(values), true);
  if (table === "regie_report_work_hours")
    return values.context_id === null
      ? isolated(values, "regie-hours")
      : regieCollection(project(values), true);
  if (
    table === "product_delivery_special_records" &&
    column === "price_per_unit"
  )
    return values.context_id === null
      ? isolated(values, "delivery-prices")
      : deliveryCollection(project(values), true);
  if (
    table === "tools" &&
    ["purchase_price", "usage_cost_per_day"].includes(column)
  )
    return toolCollection("tool", id, "procurement");
  if (table === "tool_inventories")
    return toolCollection("tool", id, "measurement");
  if (table === "tool_trackings") {
    const tracking = publicId(values.entity_id);
    return toolCollection(
      "tool-tracking",
      tracking,
      column === "tool_usage_cost_per_day" ? "procurement" : "master-data",
    );
  }
  if (table === "tool_tracking_transfer_requests" || table === "resource_notes")
    return isolated(values, table as string);
  return rootArea(values);
}
export function legacyNameArea(
  values: Values,
  part: NamePart,
): Collection | null {
  if (part === "actor") {
    const scope = "history:unknown-actors";
    return values.actor_user_id === null
      ? {
          scope,
          domain: `${scope}:scope`,
          facet: "scope",
          prefix: LEGACY_ACTIVITY_PREFIX,
        }
      : personnelCollection(publicId(values.actor_user_id), "master-data");
  }
  if (part === "context")
    return values.context_id === null
      ? null
      : projectCollection(publicId(values.context_id));
  return ["project_files", "project_file_folders"].includes(
    values.entity_table as string,
  )
    ? fileCollection(publicId(values.resource_id))
    : rootArea(values);
}
export function legacyActivityObject(
  area: Collection,
  source: string,
  part: LegacyActivity["part"],
): string {
  publicId(source);
  if (BigInt(source) < 1n) throw new InvalidProtectedData();
  return `${LEGACY_ACTIVITY_PREFIX}${area.domain}:${source}:${part}`;
}
function checkedRow(input: unknown): BusinessRow {
  const row = decodeBusinessRow(input);
  const values = row.values;
  if (
    row.table !== "entity_changes" ||
    !RESOURCE_TYPES.includes(values.resource_type as ResourceType)
  )
    throw new InvalidProtectedData();
  for (const key of [
    "id",
    "resource_id",
    "context_id",
    "actor_user_id",
    "subject_user_id",
  ])
    if (values[key] !== null) addressId(publicId(values[key]));
  if (
    !/^[a-z][a-z0-9_]{0,100}$/.test(values.entity_table as string) ||
    !(values.entity_id as string).length ||
    (values.changed_columns as string[]).some(
      (column) => !/^[a-z_][a-z0-9_]{0,100}$/.test(column),
    )
  )
    throw new InvalidProtectedData();
  return row;
}

/** Names retain their original spelling but use the name owner's key. Rate
 * readers do not obtain historical employee/project names as a side effect. */
export function splitLegacyActivity(input: unknown): LegacyActivityPart[] {
  const row = checkedRow(input);
  const values = row.values;
  const source = values.id as string;
  const occurredMicros = timestampMicros(
    values.occurred_at as string,
  ).toString();
  const groups = new Map<string, { area: Collection; columns: string[] }>();
  for (const column of values.changed_columns as string[]) {
    const area = columnArea(values, column);
    let group = groups.get(area.domain);
    if (!group) {
      group = { area, columns: [] };
      groups.set(area.domain, group);
    }
    group.columns.push(column);
  }
  if (!groups.size) {
    const area = columnArea(values, "id");
    groups.set(area.domain, { area, columns: [] });
  }
  // Historical descriptions are normally NULL (the old trigger never wrote
  // one). Do not silently broaden an exceptional mixed-facet description.
  if (values.description !== null && groups.size > 1)
    throw new InvalidProtectedData();
  const parts: LegacyActivityPart[] = [];
  for (const { area, columns } of groups.values()) {
    const value: LegacyEvent = {
      format: "sortsys-legacy-activity-v1",
      part: "event",
      row: {
        ...row,
        values: {
          ...values,
          changed_columns: [...new Set(columns)].sort(),
          title: "",
          resource_title: null,
          context_title: null,
          actor_name: null,
        },
      },
    };
    parts.push({
      area,
      id: legacyActivityObject(area, source, "event"),
      value,
      source,
      occurredMicros,
    });
  }
  for (const part of ["resource", "context", "actor"] as const) {
    const area = legacyNameArea(values, part);
    if (!area) continue;
    const value: LegacyName = {
      format: "sortsys-legacy-activity-v1",
      part,
      source,
      resourceType:
        part === "resource" ? (values.resource_type as ResourceType) : null,
      resourceId: part === "resource" ? publicId(values.resource_id) : null,
      entityTable: part === "resource" ? (values.entity_table as string) : null,
      contextId:
        part === "actor" || values.context_id === null
          ? null
          : publicId(values.context_id),
      actorId:
        part !== "actor" || values.actor_user_id === null
          ? null
          : publicId(values.actor_user_id),
      title: part === "resource" ? (values.title as string) : null,
      resourceTitle:
        part === "resource" ? (values.resource_title as string | null) : null,
      contextTitle:
        part === "context" ? (values.context_title as string | null) : null,
      actorName: part === "actor" ? (values.actor_name as string | null) : null,
    };
    parts.push({
      area,
      id: legacyActivityObject(area, source, part),
      value,
      source,
      occurredMicros,
    });
  }
  return parts;
}
export function legacyActivity(
  input: unknown,
  object: string,
  area: Collection,
): LegacyActivity {
  if (
    input &&
    typeof input === "object" &&
    (input as { part?: unknown }).part === "event"
  ) {
    const value = record(input, ["format", "part", "row"]);
    const row = checkedRow(value.row);
    const values = row.values;
    if (
      value.format !== "sortsys-legacy-activity-v1" ||
      object !== legacyActivityObject(area, values.id as string, "event") ||
      values.title !== "" ||
      ["actor_name", "context_title", "resource_title"].some(
        (key) => values[key] !== null,
      ) ||
      (values.changed_columns as string[]).some(
        (column) => columnArea(values, column).domain !== area.domain,
      ) ||
      (!(values.changed_columns as string[]).length &&
        columnArea(values, "id").domain !== area.domain)
    )
      throw new InvalidProtectedData();
    return { format: value.format, part: "event", row };
  }
  const values = record(input, [
    "format",
    "part",
    "source",
    "resourceType",
    "resourceId",
    "entityTable",
    "contextId",
    "actorId",
    "title",
    "resourceTitle",
    "contextTitle",
    "actorName",
  ]);
  if (
    values.format !== "sortsys-legacy-activity-v1" ||
    !["resource", "context", "actor"].includes(values.part as string) ||
    (values.part === "resource" &&
      (!RESOURCE_TYPES.includes(values.resourceType as ResourceType) ||
        typeof values.entityTable !== "string" ||
        !/^[a-z][a-z0-9_]{0,100}$/.test(values.entityTable))) ||
    (values.part !== "resource" &&
      (values.resourceType !== null ||
        values.resourceId !== null ||
        values.entityTable !== null)) ||
    (values.part !== "actor" && values.actorId !== null) ||
    (values.part === "actor" && values.contextId !== null)
  )
    throw new InvalidProtectedData();
  for (const key of ["resourceId", "contextId", "actorId"])
    if (values[key] !== null) addressId(values[key]);
  for (const key of ["title", "resourceTitle", "contextTitle", "actorName"])
    if (
      values[key] !== null &&
      (typeof values[key] !== "string" ||
        (values[key] as string).includes("\0") ||
        (values[key] as string).length > 20 * 1024 * 1024)
    )
      throw new InvalidProtectedData();
  const expected = legacyNameArea(
    {
      id: values.source,
      resource_type: values.resourceType,
      resource_id:
        values.resourceId === null ? null : addressId(values.resourceId),
      entity_table: values.entityTable,
      context_id:
        values.contextId === null ? null : addressId(values.contextId),
      actor_user_id: values.actorId === null ? null : addressId(values.actorId),
    },
    values.part as NamePart,
  );
  if (
    !expected ||
    expected.domain !== area.domain ||
    object !==
      legacyActivityObject(
        area,
        values.source as string,
        values.part as NamePart,
      ) ||
    (values.part !== "resource" &&
      (values.title !== null || values.resourceTitle !== null)) ||
    (values.part !== "context" && values.contextTitle !== null) ||
    (values.part !== "actor" && values.actorName !== null)
  )
    throw new InvalidProtectedData();
  return values as LegacyName;
}

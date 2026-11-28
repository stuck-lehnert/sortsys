import {
  CREATION_FACETS,
  InvalidProtectedData,
  record,
  sized,
  type Facet,
} from "@sortsys/zerotrust/sortsys";
import type { QueryResult } from "@sortsys/v2-client";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import type { Collection } from "./protectedObjects";
import { publicId } from "./products";
import {
  decodeBusinessFields,
  type BusinessFields,
  type BusinessRow,
} from "./rowCodec";
import { businessSchema, tableDefinition } from "./schema";
import { defineDataModel } from "./runtime/model";
import type { DataRequest, DataTransaction, DataView } from "./runtime/runtime";
import { toolReturnKey, type ToolReturnKey } from "./toolReturnKey";

export type ToolNamespace = "tool" | "tool-tracking";
export type ToolBookingTool = NonNullable<
  QueryResult<"tools.trackings.list">[number]["toolSummary"]
>;
export type ToolPart = {
  format: "sortsys-tool-part-v1";
  schema: string;
  namespace: ToolNamespace;
  id: string;
  facet: Facet;
  deleted: boolean;
  activeTrackingId: string | null;
  rows: BusinessFields[];
  toolSummary?: ToolBookingTool;
  returnKey?: ToolReturnKey;
  deferredRate?: string;
};

export function deferredToolRate(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) {
    throw new InvalidProtectedData();
  }
  return input;
}

export function bookingToolSummary(row: BusinessFields): ToolBookingTool {
  if (row.table !== "tools") throw new InvalidProtectedData();
  return decodeBookingTool({
    id: publicId(row.values.id),
    customId: Number(row.values.custom_id),
    brand: row.values.brand,
    category: row.values.category,
    label: row.values.label,
  });
}
function decodeBookingTool(input: unknown): ToolBookingTool {
  const value = record(input, ["id", "customId", "brand", "category", "label"]);
  addressId(value.id);
  addressText(value.brand, true, 127);
  addressText(value.category, true, 127);
  addressText(value.label, false, 255);
  if (
    typeof value.customId !== "number" ||
    !Number.isSafeInteger(value.customId) ||
    value.customId < 1 ||
    value.customId > 2147483647
  )
    throw new InvalidProtectedData();
  return value as ToolBookingTool;
}
export type ToolIndex = {
  format: "sortsys-tool-index-v1";
  entries: { id: string; customId: number }[];
};
export const TOOL_INDEX: Collection = {
  domain: "catalog:tools:master-data",
  scope: "catalog:tools",
  facet: "master-data",
  prefix: "tool-index",
};
export const TOOL_QUERIES = new Set([
  "tools.list",
  "tools.get",
  "tools.categories",
  "tools.brands",
  "tools.suggestNextCustomId",
  "tools.trackings.list",
  "tools.trackings.transfers.list",
  "tools.inventories.overview",
  "tools.inventories.list",
]);
export const TOOL_MUTATIONS = new Set([
  "tools.create",
  "tools.update",
  "tools.delete",
  "tools.archive",
  "tools.unarchive",
  "tools.track",
  "tools.trackMany",
  "tools.untrack",
  "tools.trackings.return",
  "tools.trackings.transfers.request",
  "tools.trackings.transfers.accept",
  "tools.trackings.transfers.deny",
  "tools.inventories.create",
  "tools.inventories.delete",
]);

/** Business queries follow their actual encrypted inputs. A booking key change
 * must not restart an unrelated tool-name or price read. */
export function toolQueryAffected(
  path: string,
  domains?: ReadonlySet<string>,
): boolean {
  if (!TOOL_QUERIES.has(path)) return false;
  if (!domains) return true;
  for (const domain of domains) {
    if (path === "tools.suggestNextCustomId") {
      if (domain === TOOL_INDEX.domain) return true;
      continue;
    }
    const part = toolDomain(domain);
    if (!part) continue;
    const { namespace, facet } = part;
    switch (path) {
      case "tools.get":
      case "tools.list":
        if (
          namespace === "tool" &&
          ["master-data", "procurement"].includes(facet)
        )
          return true;
        break;
      case "tools.brands":
      case "tools.categories":
        if (namespace === "tool" && facet === "master-data") return true;
        break;
      case "tools.trackings.list":
        if (
          namespace === "tool-tracking" &&
          ["master-data", "procurement"].includes(facet)
        )
          return true;
        break;
      case "tools.trackings.transfers.list":
        if (
          namespace === "tool-tracking" &&
          ["master-data", "scope"].includes(facet)
        )
          return true;
        break;
      case "tools.inventories.list":
        if (namespace === "tool" && facet === "measurement") return true;
        break;
      case "tools.inventories.overview":
        if (
          namespace === "tool" &&
          ["master-data", "measurement"].includes(facet)
        )
          return true;
        if (namespace === "tool-tracking" && facet === "master-data")
          return true;
        break;
    }
  }
  return false;
}
export function toolTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value === "string" &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value.slice(0, 10))) ||
      new Date(value.slice(0, 10)).toISOString().slice(0, 10) !==
        value.slice(0, 10))
  )
    throw new InvalidProtectedData();
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || !Number.isFinite(date.getTime()))
    throw new InvalidProtectedData();
  return date.toISOString();
}
export function toolCollection(
  namespace: ToolNamespace,
  id: string,
  facet: Facet,
): Collection {
  addressId(id);
  if (!(CREATION_FACETS[namespace] as readonly Facet[]).includes(facet))
    throw new InvalidProtectedData();
  const scope = `${namespace}:${id}`;
  return {
    domain: `${scope}:${facet}`,
    scope,
    facet,
    prefix: `${scope}:${facet}:record`,
  };
}
export function toolDomain(
  domain: string,
): { namespace: ToolNamespace; id: string; facet: Facet } | null {
  const match =
    /^(tool|tool-tracking):([1-9a-v][0-9a-v]{0,12}):([a-z-]+)$/.exec(domain);
  if (!match) return null;
  const namespace = match[1] as ToolNamespace,
    facet = match[3] as Facet;
  if (!(CREATION_FACETS[namespace] as readonly Facet[]).includes(facet))
    return null;
  addressId(match[2]);
  return { namespace, id: match[2]!, facet };
}
function layout(
  namespace: ToolNamespace,
  facet: Facet,
): { table: string; columns: string[]; kind: "entity" | "fragment" } {
  const table =
    namespace === "tool"
      ? facet === "measurement"
        ? "tool_inventories"
        : "tools"
      : facet === "scope"
        ? "tool_tracking_transfer_requests"
        : "tool_trackings";
  const costs =
    table === "tools"
      ? ["purchase_price", "usage_cost_per_day"]
      : ["tool_usage_cost_per_day"];
  return {
    table,
    columns: tableDefinition(table)
      .columns.map((column) => column.name)
      .filter((column) =>
        facet === "procurement"
          ? column === "id" || costs.includes(column)
          : !costs.includes(column),
      ),
    kind: facet === "procurement" ? "fragment" : "entity",
  };
}
export const TOOL_MODEL = defineDataModel<ToolPart>({
  name: "tool-resources",
  decode(input, object, area) {
    const hasSummary =
      !!input &&
      typeof input === "object" &&
      Object.hasOwn(input, "toolSummary");
    const hasReturnKey =
      !!input && typeof input === "object" && Object.hasOwn(input, "returnKey");
    const hasDeferredRate =
      !!input && typeof input === "object" && Object.hasOwn(input, "deferredRate");
    const part = toolDomain(area.domain),
      value = record(input, [
        "format",
        "schema",
        "namespace",
        "id",
        "facet",
        "deleted",
        "activeTrackingId",
        "rows",
        ...(hasSummary ? ["toolSummary"] : []),
        ...(hasReturnKey ? ["returnKey"] : []),
        ...(hasDeferredRate ? ["deferredRate"] : []),
      ]);
    if (
      !part ||
      object !== toolCollection(part.namespace, part.id, part.facet).prefix ||
      area.scope !== `${part.namespace}:${part.id}` ||
      area.facet !== part.facet ||
      value.format !== "sortsys-tool-part-v1" ||
      value.schema !== businessSchema.fingerprint ||
      value.namespace !== part.namespace ||
      value.id !== part.id ||
      value.facet !== part.facet ||
      typeof value.deleted !== "boolean" ||
      !Array.isArray(value.rows) ||
      value.rows.length > 20000
    )
      throw new InvalidProtectedData();
    if (value.activeTrackingId !== null) {
      if (
        part.namespace !== "tool" ||
        part.facet !== "master-data" ||
        value.deleted
      )
        throw new InvalidProtectedData();
      addressId(value.activeTrackingId);
    }
    let returnKey: ToolReturnKey | undefined;
    if (hasReturnKey) {
      if (
        part.namespace !== "tool-tracking" ||
        part.facet !== "master-data" ||
        value.deleted
      ) throw new InvalidProtectedData();
      returnKey = toolReturnKey(value.returnKey, area.scope);
    }
    if (hasDeferredRate) {
      if (
        part.namespace !== "tool-tracking" ||
        part.facet !== "master-data" ||
        value.deleted
      ) {
        throw new InvalidProtectedData();
      }
      deferredToolRate(value.deferredRate);
    }
    const expected = layout(part.namespace, part.facet),
      seen = new Set<string>();
    const rows = value.rows.map((input) => {
      const row = record(input, ["table", "values"]);
      if (row.table !== expected.table) throw new InvalidProtectedData();
      const values = record(row.values, expected.columns),
        checked = decodeBusinessFields(expected.table, values),
        id = publicId(values.id);
      addressId(id);
      if (seen.has(id)) throw new InvalidProtectedData();
      seen.add(id);
      if (
        ["tools", "tool_trackings"].includes(expected.table)
          ? id !== part.id
          : publicId(
              values[
                part.namespace === "tool" ? "tool_id" : "tool_tracking_id"
              ],
            ) !== part.id
      )
        throw new InvalidProtectedData();
      if (expected.table === "tools" && part.facet === "master-data") {
        addressText(values.brand, true, 127);
        addressText(values.category, true, 127);
      }
      for (const column of [
        "purchase_price",
        "usage_cost_per_day",
        "tool_usage_cost_per_day",
      ])
        if (
          values[column] !== undefined &&
          values[column] !== null &&
          (typeof values[column] !== "number" || (values[column] as number) < 0)
        )
          throw new InvalidProtectedData();
      return checked;
    });
    if (
      value.deleted
        ? rows.length > 0
        : ["tools", "tool_trackings"].includes(expected.table) &&
          rows.length !== 1
    )
      throw new InvalidProtectedData();
    if (
      returnKey &&
      (rows[0]!.values.responsible_user_id === null ||
        returnKey.recipient.recipient !== `user:${publicId(rows[0]!.values.responsible_user_id)}`)
    ) throw new InvalidProtectedData();
    let toolSummary: ToolBookingTool | undefined;
    if (hasSummary) {
      if (part.namespace !== "tool-tracking" || part.facet !== "master-data")
        throw new InvalidProtectedData();
      toolSummary = decodeBookingTool(value.toolSummary);
      if (
        !value.deleted &&
        toolSummary.id !== publicId(rows[0]!.values.tool_id)
      )
        throw new InvalidProtectedData();
    }
    return {
      ...value,
      rows,
      ...(toolSummary ? { toolSummary } : {}),
      ...(returnKey ? { returnKey } : {}),
    } as ToolPart;
  },
  sources: (value) =>
    value.rows.map((row, index) => ({
      ...row,
      kind: layout(value.namespace, value.facet).kind,
      fields: Object.fromEntries(
        Object.keys(row.values)
          .filter((column) => column !== "id")
          .map((column) => [
            column,
            { path: ["rows", index, "values", column] },
          ]),
      ),
    })),
  tables: (area) => {
    const part = toolDomain(area.domain);
    if (!part) throw new InvalidProtectedData();
    return [layout(part.namespace, part.facet).table];
  },
  externalReferences: ["users", "projects", "tools", "tool_trackings"],
});
export const TOOL_INDEX_MODEL = defineDataModel<ToolIndex>({
  name: "tool-index",
  decode(input, object, area) {
    const value = record(input, ["format", "entries"]);
    if (
      object !== TOOL_INDEX.prefix ||
      area.domain !== TOOL_INDEX.domain ||
      area.scope !== TOOL_INDEX.scope ||
      area.facet !== TOOL_INDEX.facet ||
      value.format !== "sortsys-tool-index-v1" ||
      !Array.isArray(value.entries) ||
      value.entries.length > 100000
    )
      throw new InvalidProtectedData();
    const ids = new Set<string>(),
      numbers = new Set<number>();
    const entries = value.entries.map((input) => {
      const entry = record(input, ["id", "customId"]);
      addressId(entry.id);
      if (
        typeof entry.customId !== "number" ||
        !Number.isSafeInteger(entry.customId) ||
        entry.customId < 1 ||
        entry.customId > 2147483647 ||
        ids.has(entry.id as string) ||
        numbers.has(entry.customId)
      )
        throw new InvalidProtectedData();
      ids.add(entry.id as string);
      numbers.add(entry.customId);
      return entry as { id: string; customId: number };
    });
    return { format: value.format, entries };
  },
  sources: () => [],
  tables: [],
});
export const toolIndexRequest = { model: TOOL_INDEX_MODEL, area: TOOL_INDEX };
export const toolRequest = (
  namespace: ToolNamespace,
  id: string,
  facet: Facet,
): DataRequest<ToolPart> => ({
  model: TOOL_MODEL,
  area: toolCollection(namespace, id, facet),
});

type ToolBookingState = {
  format: "sortsys-tool-booking-state-v1";
  toolId: string;
  trackingId: string | null;
  returnKey?: string;
};

export function toolBookingArea(toolId: string): Collection {
  const area = toolCollection("tool", toolId, "master-data");
  return { ...area, prefix: `${area.scope}:master-data:booking` };
}

export const TOOL_BOOKING_MODEL = defineDataModel<ToolBookingState>({
  name: "tool-booking-state",
  tables: [],
  sources: () => [],
  decode(input, object, area) {
    const value = partialAddressRecord(input, ["format", "toolId", "trackingId", "returnKey"]);
    addressId(value.toolId);
    const expected = toolBookingArea(value.toolId as string);
    if (
      value.format !== "sortsys-tool-booking-state-v1" ||
      area.domain !== expected.domain ||
      area.scope !== expected.scope ||
      area.facet !== expected.facet ||
      object !== expected.prefix
    )
      throw new InvalidProtectedData();
    if (value.trackingId !== null) addressId(value.trackingId);
    if (value.returnKey !== undefined) {
      if (value.trackingId === null || typeof value.returnKey !== "string")
        throw new InvalidProtectedData();
      sized(value.returnKey, 32);
    }
    return value as ToolBookingState;
  },
});

export function toolBookingRequest(toolId: string) {
  return { model: TOOL_BOOKING_MODEL, area: toolBookingArea(toolId) };
}

export function toolBookingState(
  toolId: string,
  trackingId: string | null,
  returnKey?: string,
): ToolBookingState {
  return {
    format: "sortsys-tool-booking-state-v1",
    toolId,
    trackingId,
    ...(returnKey === undefined ? {} : { returnKey }),
  };
}

export function checkToolReturnBinding(view: DataView, toolId: string, tracking: ToolPart) {
  const [booking] = view.documents(toolBookingRequest(toolId));
  if (booking?.value.returnKey !== tracking.returnKey?.verificationKey)
    throw new InvalidProtectedData();
}

export function activeToolBooking(
  view: DataView,
  tool: ToolPart,
  returned?: ReadonlyMap<string, unknown>,
): string | null {
  const booking = toolBookingPointer(view, tool.id);
  if (booking?.returnKey && returned?.has(booking.returnKey)) return null;
  return booking ? booking.trackingId : tool.activeTrackingId;
}

export function toolBookingPointer(view: DataView, toolId: string) {
  return view.documents(toolBookingRequest(toolId))[0]?.value;
}

export function setActiveToolBooking(
  tx: DataTransaction,
  toolId: string,
  trackingId: string | null,
  returnKey?: string,
) {
  const request = toolBookingRequest(toolId);
  if (tx.documents(request).length) {
    tx.edit(request, request.area.prefix, (booking) => {
      booking.trackingId = trackingId;
      if (returnKey === undefined) delete booking.returnKey;
      else booking.returnKey = returnKey;
    });
  } else {
    tx.create(
      request,
      request.area.prefix,
      toolBookingState(toolId, trackingId, returnKey),
    );
  }
}

export function toolPart(
  namespace: ToolNamespace,
  id: string,
  facet: Facet,
  rows: BusinessRow[],
  activeTrackingId: string | null = null,
  toolSummary?: ToolBookingTool,
  returnKey?: ToolReturnKey,
  deferredRate?: string,
): ToolPart {
  const expected = layout(namespace, facet);
  return {
    format: "sortsys-tool-part-v1",
    schema: businessSchema.fingerprint,
    namespace,
    id,
    facet,
    deleted: false,
    activeTrackingId,
    ...(namespace === "tool-tracking" && facet === "master-data" && toolSummary
      ? { toolSummary }
      : {}),
    ...(namespace === "tool-tracking" && facet === "master-data" && returnKey
      ? { returnKey }
      : {}),
    ...(namespace === "tool-tracking" && facet === "master-data" && deferredRate
      ? { deferredRate }
      : {}),
    rows: rows
      .filter((row) => row.table === expected.table)
      .map((row) => ({
        table: row.table,
        values: Object.fromEntries(
          expected.columns.map((column) => [column, row.values[column]]),
        ),
      })),
  };
}
export function toolChanges(
  input: unknown,
  creating = false,
): Record<string, unknown> {
  const source = partialAddressRecord(input, [
      ...(creating ? ["customId"] : []),
      "brand",
      "category",
      "label",
      "purchasePrice",
      "usageCostPerDay",
      "status",
    ]),
    result: Record<string, unknown> = {};
  if (creating) {
    if (
      typeof source.customId !== "number" ||
      !Number.isInteger(source.customId) ||
      source.customId < 1 ||
      source.customId > 2147483647
    )
      throw new InvalidProtectedData();
    result.custom_id = String(source.customId);
  }
  for (const key of ["brand", "category"] as const)
    if (creating || Object.hasOwn(source, key))
      result[key] = addressText(source[key], true, 127);
  if (creating || Object.hasOwn(source, "label"))
    result.label = addressText(source.label, false, 255);
  for (const [key, column] of [
    ["purchasePrice", "purchase_price"],
    ["usageCostPerDay", "usage_cost_per_day"],
  ])
    if (creating || Object.hasOwn(source, key!)) {
      const value = source[key!];
      if (
        value != null &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      )
        throw new InvalidProtectedData();
      result[column!] = value ?? null;
    }
  if (creating || Object.hasOwn(source, "status")) {
    if (
      source.status != null &&
      !["lost", "broken"].includes(source.status as string)
    )
      throw new InvalidProtectedData();
    result.status = source.status ?? null;
  }
  return result;
}

import {
  CREATION_FACETS,
  InvalidProtectedData,
  record,
  type Facet,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import type { Collection } from "./protectedObjects";
import { publicId } from "./products";
import {
  decodeBusinessFields,
  decodeBusinessRow,
  type BusinessFields,
  type BusinessRow,
} from "./rowCodec";
import { businessSchema, tableDefinition } from "./schema";
import { defineDataModel } from "./runtime/model";
import type { DataRequest } from "./runtime/runtime";

export type ToolNamespace = "tool" | "tool-tracking";
export type ToolPart = {
  format: "sortsys-tool-part-v1";
  schema: string;
  namespace: ToolNamespace;
  id: string;
  facet: Facet;
  deleted: boolean;
  activeTrackingId: string | null;
  rows: BusinessFields[];
};
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
  "tools.trackings.transfers.request",
  "tools.trackings.transfers.accept",
  "tools.trackings.transfers.deny",
  "tools.inventories.create",
  "tools.inventories.delete",
]);
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
    return { ...value, rows } as ToolPart;
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
export function toolPart(
  namespace: ToolNamespace,
  id: string,
  facet: Facet,
  rows: BusinessRow[],
  activeTrackingId: string | null = null,
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
export function toolRow(
  table: string,
  values: Record<string, unknown>,
): BusinessRow {
  return decodeBusinessRow({
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table,
    values,
  });
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

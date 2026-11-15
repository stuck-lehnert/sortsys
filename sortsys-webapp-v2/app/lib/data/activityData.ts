import type { QueryResult } from "@sortsys/v2-client";
import {
  historyInstant,
  historySequence,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { dataKey } from "./runtime/model";
import type { RowSource } from "./runtime/model";
import { primaryColumns, tableDefinition } from "./schema";

export type Activity = QueryResult<"personalization.activity.list">[number];
export type ResourceType = Activity["resourceType"];
export type ActivityPosition = {
  instant: bigint;
  order: bigint;
  sequence: bigint;
  ordinal: number;
};
export type ActivityCandidate = ActivityPosition & {
  item: Activity;
  group: string;
};

// Newest timestamp first; ties use the original action ID, then its stored
// sequence. Rows from the same stored change retain their original order.
export function activityOrder(
  left: ActivityPosition,
  right: ActivityPosition,
): number {
  if (left.instant !== right.instant) {
    return left.instant > right.instant ? -1 : 1;
  }
  if (left.order !== right.order) {
    return left.order > right.order ? -1 : 1;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence > right.sequence ? -1 : 1;
  }
  return left.ordinal - right.ordinal;
}
export function activityId(value: ActivityPosition, legacy = false): string {
  return `${legacy ? "l" : "h"}_${value.instant}_${value.order}_${value.sequence}_${value.ordinal}`;
}
export function activityCursor(
  value: unknown,
): ActivityPosition & { legacy: boolean } {
  if (typeof value !== "string") {
    throw new InvalidProtectedData();
  }
  const match =
    /^([hl])_(-?(?:0|[1-9]\d{0,18}))_([1-9]\d{0,18})_([1-9]\d{0,18})_([0-9]{1,5})$/.exec(
      value,
    );
  if (!match) {
    throw new InvalidProtectedData();
  }
  historyInstant(match[2]);
  historySequence(match[3]);
  historySequence(match[4]);
  return {
    legacy: match[1] === "l",
    instant: BigInt(match[2]),
    order: BigInt(match[3]!),
    sequence: BigInt(match[4]!),
    ordinal: Number(match[5]),
  };
}
export const RESOURCE_TYPES: readonly ResourceType[] = [
  "project",
  "tool",
  "user",
  "customer",
  "contact",
  "product",
  "productVendor",
  "deliveryNote",
  "regieReport",
  "dailyProjectReport",
];
export const ACTIVITY_QUERIES = new Set(["personalization.activity.list"]);
export function activityInput(input: unknown) {
  const value = partialAddressRecord(input ?? {}, [
    "limit",
    "cursor",
    "latestPerResource",
    "resourceType",
    "resourceId",
    "contextId",
    "includeProjectContext",
  ]);
  const limit = value.limit ?? 25;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit)) {
    throw new InvalidProtectedData();
  }
  for (const field of ["latestPerResource", "includeProjectContext"]) {
    if (value[field] != null && typeof value[field] !== "boolean") {
      throw new InvalidProtectedData();
    }
  }
  if (
    value.resourceType != null &&
    !RESOURCE_TYPES.includes(value.resourceType as ResourceType)
  ) {
    throw new InvalidProtectedData();
  }
  for (const field of ["resourceId", "contextId"]) {
    if (value[field] != null) {
      addressId(value[field]);
    }
  }
  if (value.cursor != null) {
    activityCursor(value.cursor);
  }
  return {
    limit: Math.max(1, Math.min(50, limit)),
    cursor: value.cursor as string | undefined,
    latest: value.latestPerResource === true,
    resourceType: value.resourceType as ResourceType | undefined,
    resourceId: value.resourceId as string | undefined,
    contextId: value.contextId as string | undefined,
    includeProject: value.includeProjectContext === true,
  };
}
export type RowChange = {
  table: string;
  key: string;
  entityId: string;
  before?: RowSource;
  after?: RowSource;
  columns: string[];
};
const IGNORED = new Set([
  "id",
  "created_at",
  "modified_at",
  "updated_at",
  "search_vector",
]);
export function changedRows(
  before: readonly RowSource[],
  after: readonly RowSource[],
): RowChange[] {
  const key = (row: RowSource) =>
    `${row.table}\0${dataKey(row.table, row.values)}`;
  const old = new Map(before.map((row) => [key(row), row]));
  const current = new Map(after.map((row) => [key(row), row]));
  const result: RowChange[] = [];
  for (const id of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const previous = old.get(id);
    const next = current.get(id);
    const row = next ?? previous!;
    const columns = [
      ...new Set([
        ...Object.keys(previous?.values ?? {}),
        ...Object.keys(next?.values ?? {}),
      ]),
    ]
      .filter(
        (column) =>
          !IGNORED.has(column) &&
          JSON.stringify(previous?.values[column]) !==
            JSON.stringify(next?.values[column]),
      )
      .sort();
    if (previous && next && !columns.length) {
      continue;
    }
    const primary = primaryColumns(tableDefinition(row.table));
    const values = primary.map((name) => row.values[name]);
    result.push({
      table: row.table,
      key: id,
      entityId:
        values.length === 1 ? String(values[0]) : JSON.stringify(values),
      before: previous,
      after: next,
      columns,
    });
  }
  return result;
}
export function selectActivity(
  items: readonly Activity[],
  input: ReturnType<typeof activityInput>,
) {
  const seen = new Set<string>();
  const output: Activity[] = [];
  const includesProjectContext =
    input.includeProject &&
    input.resourceType === "project" &&
    Boolean(input.resourceId);

  for (const item of items) {
    const matchesType =
      !input.resourceType || item.resourceType === input.resourceType;
    const matchesId = !input.resourceId || item.resourceId === input.resourceId;
    const matchesResource = matchesType && matchesId;

    if (includesProjectContext) {
      const belongsToProject = item.contextId === input.resourceId;
      if (!matchesResource && !belongsToProject) {
        continue;
      }
    } else if (!matchesResource) {
      continue;
    }
    if (input.contextId && item.contextId !== input.contextId) {
      continue;
    }

    const key = `${item.resourceType}:${item.resourceId}`;
    if (input.latest && seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

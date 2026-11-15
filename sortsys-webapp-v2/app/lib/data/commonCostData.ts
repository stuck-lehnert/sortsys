import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { calendarDay } from "./calendarDays";
import { effectiveHistory } from "./effectiveHistory";
import { COMMON_COST_COLLECTION } from "./organizationData";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

export { COMMON_COST_COLLECTION };
export const COMMON_COST_TYPES = ["fgk", "mgk", "ngk"] as const;
export type CommonCostType = (typeof COMMON_COST_TYPES)[number];
export type CommonCosts = QueryResult<"settings.costs.get">;
export type CommonCostPayload = {
  format: "sortsys-common-costs-v1";
  row: BusinessRow;
};
export type CommonCostKey = { type: CommonCostType; effectiveAt: string };
export type CommonCostValue = { relativeFactor: number; constant: number };
export type CommonCostInput = CommonCostKey & CommonCostValue;
export const COMMON_COST_QUERIES = new Set(["settings.costs.get"]);
// A client-only operation used by the form to save all three types atomically.
export const COMMON_COST_SAVE = "local.commonCosts.save";
export const COMMON_COST_MUTATIONS = new Set([
  "settings.costs.set",
  "settings.costs.update",
  "settings.costs.delete",
  COMMON_COST_SAVE,
]);

export function commonCostType(value: unknown): CommonCostType {
  if (!COMMON_COST_TYPES.includes(value as CommonCostType)) {
    throw new InvalidProtectedData();
  }
  return value as CommonCostType;
}

export function costNumber(value: unknown, nonnegative = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidProtectedData();
  }
  if (nonnegative && value < 0) {
    throw new InvalidProtectedData();
  }
  return value;
}

/** A date input denotes UTC midnight. Timestamp keys retain their exact
 * microseconds, including when a source used a different UTC offset. */
export function commonCostInstant(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${calendarDay(value)}T00:00:00.000000Z`;
  }
  const instant = timestampInstant(value);
  return timestampFromMicros(timestampMicros(instant));
}

export function commonCostObject(rowId: unknown): string {
  const id = publicId(rowId);
  addressId(id);
  return `${COMMON_COST_COLLECTION.prefix}${id}`;
}

export function commonCostPayload(
  input: unknown,
  object: string,
): CommonCostPayload {
  const payload = record(input, ["format", "row"]);
  if (payload.format !== "sortsys-common-costs-v1")
    throw new InvalidProtectedData();

  const row = decodeBusinessRow(payload.row);
  if (row.table !== "global_common_cost_entries")
    throw new InvalidProtectedData();
  const values = row.values;
  addressId(publicId(values.id));
  commonCostType(values.type);
  costNumber(values.relative_factor, true);
  costNumber(values.constant);
  if (values.created_by_user_id !== null)
    addressId(publicId(values.created_by_user_id));

  const expectedObject = commonCostObject(values.id);
  if (object !== expectedObject) throw new InvalidProtectedData();
  return { format: payload.format, row };
}

export const COMMON_COST_MODEL = defineDataModel<CommonCostPayload>({
  name: "common-costs",
  tables: ["global_common_cost_entries"],
  externalReferences: ["users"],
  decode(value, object, area) {
    if (
      area.domain !== COMMON_COST_COLLECTION.domain ||
      area.scope !== COMMON_COST_COLLECTION.scope ||
      area.facet !== COMMON_COST_COLLECTION.facet ||
      area.prefix !== COMMON_COST_COLLECTION.prefix
    ) {
      throw new InvalidProtectedData();
    }
    return commonCostPayload(value, object);
  },
});

export const commonCostRequest = {
  model: COMMON_COST_MODEL,
  area: COMMON_COST_COLLECTION,
};

export function commonCostsAt(
  rows: readonly BusinessRow[],
  cutoff: bigint,
): Map<string, BusinessRow> {
  const entries = rows.map((row) => ({
    group: row.values.type as string,
    instant: timestampMicros(row.values.effective_at as string),
    id: BigInt(row.values.id as string),
    value: row,
  }));
  return effectiveHistory(entries, cutoff);
}

function compareCostHistory(left: BusinessRow, right: BusinessRow): number {
  const typeOrder = (left.values.type as string).localeCompare(
    right.values.type as string,
  );
  if (typeOrder !== 0) return typeOrder;
  const leftTime = timestampMicros(left.values.effective_at as string);
  const rightTime = timestampMicros(right.values.effective_at as string);
  if (leftTime > rightTime) return -1;
  if (leftTime < rightTime) return 1;
  return 0;
}

export function wireCommonCosts(
  rows: readonly BusinessRow[],
  now = new Date(),
): CommonCosts {
  const active = commonCostsAt(rows, BigInt(now.getTime()) * 1000n);
  function current(type: CommonCostType): CommonCosts["fgk"] {
    const values = active.get(type)?.values;
    if (!values) {
      return { type, effectiveAt: new Date(0), relativeFactor: 0, constant: 0 };
    }
    return {
      type,
      effectiveAt: new Date(values.effective_at as string),
      relativeFactor: values.relative_factor as number,
      constant: values.constant as number,
    };
  }

  const history = [...rows].sort(compareCostHistory).map(({ values }) => ({
    id: publicId(values.id),
    type: commonCostType(values.type),
    effectiveAt: new Date(values.effective_at as string),
    relativeFactor: values.relative_factor as number,
    constant: values.constant as number,
    createdByUserId:
      values.created_by_user_id === null
        ? null
        : publicId(values.created_by_user_id),
    createdAt: new Date(values.created_at as string),
    modifiedAt: new Date(values.modified_at as string),
  }));
  const fgk = current("fgk");
  const mgk = current("mgk");
  const ngk = current("ngk");
  return {
    fgk,
    mgk,
    ngk,
    history,
    productOverheadFactor: mgk.relativeFactor + 1,
    workHourOverheadFactor: fgk.relativeFactor + 1,
    specialRecordOverheadFactor: mgk.relativeFactor + 1,
    toolOverheadFactor: 1,
  };
}

export function commonCostKey(input: unknown): CommonCostKey {
  const data = record(input, ["type", "effectiveAt"]);
  return {
    type: commonCostType(data.type),
    effectiveAt: commonCostInstant(data.effectiveAt),
  };
}

export function commonCostInput(input: unknown): CommonCostInput {
  const data = record(input, [
    "type",
    "effectiveAt",
    "relativeFactor",
    "constant",
  ]);
  return {
    ...commonCostKey({ type: data.type, effectiveAt: data.effectiveAt }),
    relativeFactor: costNumber(data.relativeFactor, true),
    constant: costNumber(data.constant),
  };
}

export function legacyCommonCostInput(
  input: unknown,
): (CommonCostValue & { type: CommonCostType })[] {
  const data = partialAddressRecord(input, [
    "productOverheadFactor",
    "workHourOverheadFactor",
    "specialRecordOverheadFactor",
    "toolOverheadFactor",
  ]);
  for (const value of Object.values(data)) costNumber(value, true);

  const changes: (CommonCostValue & { type: CommonCostType })[] = [];
  if (data.workHourOverheadFactor !== undefined) {
    changes.push({
      type: "fgk",
      relativeFactor: Math.max((data.workHourOverheadFactor as number) - 1, 0),
      constant: 0,
    });
  }
  const material = [
    data.productOverheadFactor,
    data.specialRecordOverheadFactor,
  ].filter((value): value is number => value !== undefined);
  if (material.length > 0) {
    const average =
      material.reduce((sum, value) => sum + value, 0) / material.length;
    changes.push({
      type: "mgk",
      relativeFactor: Math.max(average - 1, 0),
      constant: 0,
    });
  }
  return changes;
}

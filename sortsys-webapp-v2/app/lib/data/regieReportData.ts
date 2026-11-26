import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { aggregateRows } from "./aggregateRows";
import {
  addCalendarDays,
  calendarDay,
  calendarWeek,
  notFutureDay,
} from "./calendarDays";
import type { HistoricalPriceLookup } from "./historicalPrices";
import { publicId, wirePrice } from "./products";
import {
  projectModuleArea,
  projectModuleDecoder,
  projectModuleDomain,
} from "./projectScope";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import type { Collection } from "./protectedObjects";
import { timestampMicros } from "./timestamps";

export const REGIE_QUERIES = new Set([
  "regieReports.list",
  "regieReports.get",
  "regieReports.costs.get",
]);
export const REGIE_MUTATIONS = new Set([
  "regieReports.create",
  "regieReports.update",
  "regieReports.delete",
]);
export type RegieReport = QueryResult<"regieReports.get">;
export type RegiePayload = {
  format: "sortsys-regie-report-v1";
  report: BusinessRow | null;
  products: BusinessRow[];
  specials: BusinessRow[];
};
export type RegieHours = {
  format: "sortsys-regie-hours-v1";
  projectId: string;
  reportId: string;
  week: string;
  hours: BusinessRow[];
};
export function regieCollection(id: string, hours = false): Collection {
  return {
    ...projectModuleArea(
      id,
      "regie-reports",
      hours ? "personnel" : "master-data",
    ),
    prefix: `${hours ? "regie-hours" : "regie-report"}:${id}:`,
  };
}
export function regieDomain(
  domain: string,
): { projectId: string; hours: boolean } | null {
  const part = projectModuleDomain(domain);
  return part?.module === "regie-reports" &&
    ["personnel", "master-data"].includes(part.facet)
    ? { projectId: part.id, hours: part.facet === "personnel" }
    : null;
}
export function regiePayload(
  input: unknown,
  object: string,
  projectId: string,
): RegiePayload {
  const data = record(input, ["format", "report", "products", "specials"]),
    prefix = regieCollection(projectId).prefix;
  if (data.format !== "sortsys-regie-report-v1" || !object.startsWith(prefix))
    throw new InvalidProtectedData();
  const id = object.slice(prefix.length);
  addressId(id);
  if (data.report === null) {
    if (
      !Array.isArray(data.products) ||
      data.products.length ||
      !Array.isArray(data.specials) ||
      data.specials.length
    )
      throw new InvalidProtectedData();
    return { format: data.format, report: null, products: [], specials: [] };
  }
  const report = decodeBusinessRow(data.report),
    r = report.values;
  if (
    report.table !== "regie_reports" ||
    publicId(r.id) !== id ||
    publicId(r.project_id) !== projectId ||
    calendarWeek(r.day) !== r.day
  )
    throw new InvalidProtectedData();
  if (r.created_by_user_id !== null) addressId(publicId(r.created_by_user_id));
  const products = aggregateRows(
      data.products,
      "regie_report_products",
      "report_id",
      r.id,
    ),
    specials = aggregateRows(
      data.specials,
      "regie_report_special_records",
      "report_id",
      r.id,
    );
  for (const row of products) addressId(publicId(row.values.product_id));
  return { format: data.format, report, products, specials };
}
export function regieHours(
  input: unknown,
  object: string,
  projectId: string,
): RegieHours {
  const data = record(input, [
    "format",
    "projectId",
    "reportId",
    "week",
    "hours",
  ]);
  addressId(data.reportId);
  if (
    data.format !== "sortsys-regie-hours-v1" ||
    data.projectId !== projectId ||
    object !== regieCollection(projectId, true).prefix + data.reportId ||
    calendarWeek(data.week) !== data.week
  )
    throw new InvalidProtectedData();
  const hours = aggregateRows(
    data.hours,
    "regie_report_work_hours",
    "report_id",
    addressId(data.reportId),
  );
  for (const row of hours) {
    if (
      calendarWeek(row.values.day) !== data.week ||
      (row.values.hours as number) < 0 ||
      (row.values.hours as number) > 10
    )
      throw new InvalidProtectedData();
    if (row.values.user_id !== null) addressId(publicId(row.values.user_id));
  }
  return {
    format: data.format,
    projectId,
    reportId: data.reportId as string,
    week: data.week as string,
    hours,
  };
}
export const REGIE_MODEL = defineDataModel<RegiePayload>({
  name: "regie-reports",
  tables: [
    "regie_reports",
    "regie_report_products",
    "regie_report_special_records",
  ],
  decode: projectModuleDecoder(regieCollection, regiePayload),
  externalReferences: ["projects", "users", "products"],
});
export const REGIE_HOUR_MODEL = defineDataModel<RegieHours>({
  name: "regie-hours",
  tables: ["regie_report_work_hours"],
  decode: projectModuleDecoder((id) => regieCollection(id, true), regieHours),
  externalReferences: ["regie_reports", "users"],
});
export const regieRequest = (id: string) => ({
  model: REGIE_MODEL,
  area: regieCollection(id),
});
export const regieHourRequest = (id: string) => ({
  model: REGIE_HOUR_MODEL,
  area: regieCollection(id, true),
});
export function wireRegie(
  payload: RegiePayload,
  hours: RegieHours | undefined,
  autoId: number,
): RegieReport {
  if (!payload.report || !Number.isSafeInteger(autoId) || autoId < 1)
    throw new InvalidProtectedData();
  const r = payload.report.values,
    id = publicId(r.id),
    projectId = publicId(r.project_id);
  if (
    hours &&
    (hours.reportId !== id ||
      hours.projectId !== projectId ||
      hours.week !== r.day)
  )
    throw new InvalidProtectedData();
  return {
    id,
    projectId,
    day: new Date(`${r.day}T00:00:00.000Z`),
    summary: r.summary as string | null,
    createdByUserId:
      r.created_by_user_id === null ? null : publicId(r.created_by_user_id),
    createdAt: new Date(r.created_at as string),
    autoId,
    products: payload.products.map(({ values: row }) => ({
      id: publicId(row.id),
      reportId: id,
      productId: publicId(row.product_id),
      quantity: row.quantity as number,
      comment: row.comment as string | null,
    })),
    specialRecords: payload.specials.map(({ values: row }) => ({
      id: publicId(row.id),
      reportId: id,
      name: row.name as string,
      unit: row.unit as string,
      amount: row.amount as number,
      comment: row.comment as string | null,
    })),
    workHours: (hours?.hours ?? []).map(({ values: row }) => ({
      id: publicId(row.id),
      reportId: id,
      userId: row.user_id === null ? null : publicId(row.user_id),
      day: new Date(`${row.day}T00:00:00.000Z`),
      hours: row.hours as number,
    })),
  };
}
export function regieMaterialCosts(
  report: RegieReport,
  priceAt?: HistoricalPriceLookup,
): QueryResult<"regieReports.costs.get"> {
  if (report.products.length && !priceAt) throw new InvalidProtectedData();
  const cutoff = timestampMicros(
    `${addCalendarDays(calendarDay(report.day), 7)}T00:00:00Z`,
  );
  let totalCost = 0;
  const products = report.products.map((line) => {
    const price = priceAt?.(line.productId, cutoff);
    const priceRecord = price ? wirePrice(price) : null;
    totalCost += line.quantity * (priceRecord?.price ?? 0);
    return {
      recordId: line.id,
      productId: line.productId,
      quantity: line.quantity,
      priceRecord,
    };
  });
  if (!Number.isFinite(totalCost)) throw new InvalidProtectedData();
  return {
    reportId: report.id,
    workHoursAvailable: report.workHoursAvailable !== false,
    totalCost,
    products,
    specialRecords: report.specialRecords.map(
      ({ id, name, unit, amount, comment }) => ({
        recordId: id,
        name,
        unit,
        amount,
        comment,
      }),
    ),
    workHours: report.workHours.map(({ id, userId, day, hours }) => ({
      recordId: id,
      userId,
      day,
      hours,
    })),
  };
}

type LineIdentity = { id?: string };
export type RegieProductChange = LineIdentity & {
  productId: string;
  quantity: number;
  comment?: string | null;
};
export type RegieSpecialChange = LineIdentity & {
  name: string;
  unit: string;
  amount: number;
  comment?: string | null;
};
export type RegieHourChange = LineIdentity & {
  userId: string | null;
  day: string;
  hours: number;
};
export type RegieChanges = {
  day?: string;
  summary?: string | null;
  products?: RegieProductChange[];
  specials?: RegieSpecialChange[];
  hours?: RegieHourChange[];
};
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new InvalidProtectedData();
  return value;
}
function lines<T>(
  input: unknown,
  parse: (row: Record<string, unknown>) => T,
  fields: string[],
  creating: boolean,
): T[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 10000)
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  return input.map((value) => {
    const row = partialAddressRecord(value, [
      ...(!creating ? ["id"] : []),
      ...fields,
    ]);
    if (row.id != null) {
      addressId(row.id);
      if (seen.has(row.id as string)) throw new InvalidProtectedData();
      seen.add(row.id as string);
    }
    return {
      ...parse(row),
      ...(row.id == null ? {} : { id: row.id as string }),
    };
  });
}
export function regieChanges(input: unknown, creating: boolean): RegieChanges {
  const data = partialAddressRecord(input, [
      "day",
      "summary",
      "products",
      "specialRecords",
      "workHours",
    ]),
    result: RegieChanges = {};
  if (creating || data.day !== undefined)
    result.day = calendarWeek(notFutureDay(data.day));
  if (creating || data.summary !== undefined)
    result.summary = addressText(data.summary, false, 4095);
  if (creating || data.products !== undefined)
    result.products = lines(
      data.products,
      (row) => {
        addressId(row.productId);
        return {
          productId: row.productId as string,
          quantity: finite(row.quantity),
          ...(row.comment === undefined
            ? {}
            : { comment: addressText(row.comment, false, 255) }),
        };
      },
      ["productId", "quantity", "comment"],
      creating,
    );
  if (creating || data.specialRecords !== undefined)
    result.specials = lines(
      data.specialRecords,
      (row) => ({
        name: addressText(row.name, true, 255)!,
        unit: addressText(row.unit, true, 32)!,
        amount: finite(row.amount),
        ...(row.comment === undefined
          ? {}
          : { comment: addressText(row.comment, false, 255) }),
      }),
      ["name", "unit", "amount", "comment"],
      creating,
    );
  if (creating || data.workHours !== undefined)
    result.hours = lines(
      data.workHours,
      (row) => {
        if (row.userId != null) addressId(row.userId);
        const hours = finite(row.hours);
        if (hours < 0 || hours > 10) throw new InvalidProtectedData();
        return {
          userId: (row.userId as string | null) ?? null,
          day: notFutureDay(row.day),
          hours,
        };
      },
      ["userId", "day", "hours"],
      creating,
    );
  if (
    (creating &&
      !result.products!.length &&
      !result.specials!.length &&
      !result.hours!.length) ||
    (!creating && !Object.keys(result).length)
  )
    throw new InvalidProtectedData();
  return result;
}

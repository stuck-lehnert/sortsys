import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { aggregateRows } from "./aggregateRows";
import { publicId } from "./products";
import { projectModuleArea, projectModuleDomain } from "./projectScope";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import { calendarDay } from "./calendarDays";
export { calendarDay } from "./calendarDays";
import type { Collection } from "./protectedObjects";

export const DAILY_QUERIES = new Set([
  "projects.dailyReports.list",
  "projects.dailyReports.get",
]);
export const DAILY_MUTATIONS = new Set([
  "projects.dailyReports.create",
  "projects.dailyReports.update",
  "projects.dailyReports.delete",
  "projects.dailyReports.photos.add",
  "projects.dailyReports.photos.remove",
]);
export type DailyReport = QueryResult<"projects.dailyReports.get">;
export type DailyPayload = {
  format: "sortsys-daily-report-v1";
  report: BusinessRow | null;
  hours: BusinessRow[];
  photos: BusinessRow[];
};
export type DailyCosts = {
  format: "sortsys-daily-costs-v1";
  projectId: string;
  reportId: string;
  costs: { id: string; costPerHour: number | null }[];
};
export function dailyCollection(projectId: string, costs = false): Collection {
  return {
    ...projectModuleArea(
      projectId,
      "daily-reports",
      costs ? "calculation" : "master-data",
    ),
    prefix: `${costs ? "daily-costs" : "daily-report"}:${projectId}:`,
  };
}
export function dailyDomain(
  domain: string,
): { projectId: string; costs: boolean } | null {
  const area = projectModuleDomain(domain);
  return area?.module === "daily-reports" &&
    ["master-data", "calculation"].includes(area.facet)
    ? { projectId: area.id, costs: area.facet === "calculation" }
    : null;
}
export function reportWeather(input: unknown): DailyReport["weather"] {
  if (input === null) return null;
  const value = partialAddressRecord(input, [
    "summary",
    "temperatureC",
    "precipitationMm",
    "windKph",
  ]);
  for (const field of ["temperatureC", "precipitationMm", "windKph"])
    if (
      value[field] != null &&
      (typeof value[field] !== "number" || !Number.isFinite(value[field]))
    )
      throw new InvalidProtectedData();
  if (value.summary != null && typeof value.summary !== "string")
    throw new InvalidProtectedData();
  return value as NonNullable<DailyReport["weather"]>;
}
export function dailyPayload(
  input: unknown,
  object: string,
  projectId: string,
): DailyPayload {
  const data = record(input, ["format", "report", "hours", "photos"]),
    prefix = dailyCollection(projectId).prefix;
  if (data.format !== "sortsys-daily-report-v1" || !object.startsWith(prefix))
    throw new InvalidProtectedData();
  const id = object.slice(prefix.length);
  addressId(id);
  if (data.report === null) {
    if (
      !Array.isArray(data.hours) ||
      data.hours.length ||
      !Array.isArray(data.photos) ||
      data.photos.length
    )
      throw new InvalidProtectedData();
    return { format: data.format, report: null, hours: [], photos: [] };
  }
  const report = decodeBusinessRow(data.report),
    r = report.values;
  if (
    report.table !== "daily_project_reports" ||
    publicId(r.id) !== id ||
    publicId(r.project_id) !== projectId
  )
    throw new InvalidProtectedData();
  if (r.created_by_user_id !== null) addressId(publicId(r.created_by_user_id));
  calendarDay(r.day);
  if (r.weather !== null) reportWeather(JSON.parse(r.weather as string));
  const hours = aggregateRows(
    data.hours,
    "daily_project_report_work_hours",
    "report_id",
    r.id,
  );
  for (const row of hours) {
    if (
      row.values.cost_per_hour !== null ||
      (row.values.hours as number) < 0 ||
      (row.values.hours as number) > 10 ||
      !["internal", "external", "subcontractor"].includes(
        row.values.contract_type as string,
      )
    )
      throw new InvalidProtectedData();
    if (row.values.user_id !== null) addressId(publicId(row.values.user_id));
  }
  if (!Array.isArray(data.photos) || data.photos.length > 10000)
    throw new InvalidProtectedData();
  const seen = new Set<string>(),
    photos = data.photos.map((value) => {
      const row = decodeBusinessRow(value),
        file = publicId(row.values.project_file_id);
      addressId(file);
      if (
        row.table !== "daily_project_report_files" ||
        row.values.report_id !== r.id ||
        seen.has(file)
      )
        throw new InvalidProtectedData();
      seen.add(file);
      return row;
    });
  return { format: data.format, report, hours, photos };
}
export function dailyCosts(
  input: unknown,
  object: string,
  projectId: string,
): DailyCosts {
  const data = record(input, ["format", "projectId", "reportId", "costs"]);
  addressId(data.reportId);
  if (
    data.format !== "sortsys-daily-costs-v1" ||
    data.projectId !== projectId ||
    object !== dailyCollection(projectId, true).prefix + data.reportId ||
    !Array.isArray(data.costs) ||
    data.costs.length > 10000
  )
    throw new InvalidProtectedData();
  const seen = new Set<string>(),
    costs = data.costs.map((value) => {
      const row = record(value, ["id", "costPerHour"]);
      addressId(row.id);
      if (
        seen.has(row.id as string) ||
        (row.costPerHour !== null &&
          (typeof row.costPerHour !== "number" ||
            !Number.isFinite(row.costPerHour)))
      )
        throw new InvalidProtectedData();
      seen.add(row.id as string);
      return {
        id: row.id as string,
        costPerHour: row.costPerHour as number | null,
      };
    });
  return {
    format: data.format,
    projectId,
    reportId: data.reportId as string,
    costs,
  };
}
function boundProject(area: Collection, costs: boolean): string {
  const part = dailyDomain(area.domain);
  if (
    !part ||
    part.costs !== costs ||
    area.scope !== `project:${part.projectId}:daily-reports` ||
    area.facet !== (costs ? "calculation" : "master-data") ||
    area.prefix !== dailyCollection(part.projectId, costs).prefix
  )
    throw new InvalidProtectedData();
  return part.projectId;
}
export const DAILY_MODEL = defineDataModel<DailyPayload>({
  name: "daily-reports",
  tables: [
    "daily_project_reports",
    "daily_project_report_work_hours",
    "daily_project_report_files",
  ],
  decode: (value, object, area) =>
    dailyPayload(value, object, boundProject(area, false)),
  exclude: { daily_project_report_work_hours: ["cost_per_hour"] },
  externalReferences: ["projects", "users", "project_files"],
});
export const DAILY_COST_MODEL = defineDataModel<DailyCosts>({
  name: "daily-report-costs",
  tables: ["daily_project_report_work_hours"],
  decode: (value, object, area) =>
    dailyCosts(value, object, boundProject(area, true)),
  sources: (value) =>
    value.costs.map((cost, index) => ({
      table: "daily_project_report_work_hours",
      kind: "fragment",
      values: { id: addressId(cost.id), cost_per_hour: cost.costPerHour },
      fields: { cost_per_hour: { path: ["costs", index, "costPerHour"] } },
    })),
});

export function wireDailyReport(
  value: DailyPayload,
  costs?: DailyCosts,
): Omit<DailyReport, "photos"> {
  if (!value.report) throw new InvalidProtectedData();
  const r = value.report.values,
    id = publicId(r.id);
  if (
    costs &&
    (costs.reportId !== id || costs.projectId !== publicId(r.project_id))
  )
    throw new InvalidProtectedData();
  const prices = new Map(costs?.costs.map((row) => [row.id, row.costPerHour]));
  return {
    id,
    projectId: publicId(r.project_id),
    day: new Date(`${r.day}T00:00:00.000Z`),
    summary: r.summary as string | null,
    weather:
      r.weather === null
        ? null
        : reportWeather(JSON.parse(r.weather as string)),
    createdByUserId:
      r.created_by_user_id === null ? null : publicId(r.created_by_user_id),
    createdAt: new Date(r.created_at as string),
    workHours: value.hours.map(({ values: row }) => ({
      id: publicId(row.id),
      reportId: id,
      userId: row.user_id === null ? null : publicId(row.user_id),
      hours: row.hours as number,
      costPerHour: prices.get(publicId(row.id)) ?? null,
      contractType:
        row.contract_type as DailyReport["workHours"][number]["contractType"],
    })),
  };
}

export type WorkHourChange = {
  id?: string;
  userId: string | null;
  hours: number;
  costPerHour?: number | null;
  contractType?: string;
};
export function reportHours(
  input: unknown,
  creating: boolean,
): WorkHourChange[] {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 10000)
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  return input.map((value) => {
    const data = partialAddressRecord(value, [
      ...(!creating ? ["id"] : []),
      "userId",
      "hours",
      "costPerHour",
      "contractType",
    ]);
    if (data.id != null) {
      addressId(data.id);
      if (seen.has(data.id as string)) throw new InvalidProtectedData();
      seen.add(data.id as string);
    }
    if (data.userId != null) addressId(data.userId);
    if (
      typeof data.hours !== "number" ||
      !Number.isFinite(data.hours) ||
      data.hours < 0 ||
      data.hours > 10 ||
      (data.costPerHour !== undefined &&
        data.costPerHour !== null &&
        (typeof data.costPerHour !== "number" ||
          !Number.isFinite(data.costPerHour))) ||
      (data.contractType != null &&
        !["internal", "external", "subcontractor"].includes(
          data.contractType as string,
        ))
    )
      throw new InvalidProtectedData();
    return {
      ...(data.id == null ? {} : { id: data.id as string }),
      userId: (data.userId as string | null) ?? null,
      hours: data.hours,
      ...(data.costPerHour !== undefined
        ? { costPerHour: data.costPerHour as number | null }
        : {}),
      ...(data.contractType == null
        ? {}
        : { contractType: data.contractType as string }),
    };
  });
}
export function reportSummary(input: unknown): string | null {
  return addressText(input, false, 5000);
}

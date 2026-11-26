import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { calendarDay } from "./calendarDays";
import { publicId } from "./products";
import {
  projectModuleArea,
  projectModuleDecoder,
  projectModuleDomain,
} from "./projectScope";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import { timestampInstant, timestampMicros } from "./timestamps";

export const SCHEDULE_QUERIES = new Set([
  "projects.deployments.list",
  "projects.unavailability.list",
]);
export const SCHEDULE_MUTATIONS = new Set(
  ["deployments", "unavailability"].flatMap((kind) =>
    ["create", "update", "delete"].map(
      (action) => `projects.${kind}.${action}`,
    ),
  ),
);
export type ScheduleKind = "deployment" | "unavailability";
export type SchedulePayload = {
  format: "sortsys-project-schedule-v1";
  row: BusinessRow;
  projectTitle?: string;
};
export const SCHEDULE_TABLES = {
  deployment: "project_deployments",
  unavailability: "project_unavailability_periods",
} as const;
export function scheduleCollection(project: string) {
  return {
    ...projectModuleArea(project, "planning", "master-data"),
    prefix: `schedule:${project}:`,
  };
}
export function scheduleDomain(domain: string): string | null {
  const part = projectModuleDomain(domain);
  return part?.module === "planning" && part.facet === "master-data"
    ? part.id
    : null;
}
/** A stable public row ID can have several historical placements. Fresh storage
 * IDs let a row move back without reviving a tombstoned ciphertext object. */
export function scheduleObject(
  project: string,
  kind: ScheduleKind,
  id: string,
  placement = id,
): string {
  addressId(id);
  addressId(placement);
  if (!Object.hasOwn(SCHEDULE_TABLES, kind)) throw new InvalidProtectedData();
  return `${scheduleCollection(project).prefix}${kind}:${id}:${placement}`;
}
export function scheduleChanges(
  input: unknown,
  kind: ScheduleKind,
  creating = false,
): Record<string, unknown> {
  const data = partialAddressRecord(input, [
      "projectId",
      "from",
      "to",
      "note",
      ...(kind === "deployment" ? ["userId"] : ["reason"]),
    ]),
    values: Record<string, unknown> = {};
  for (const [field, column] of [
    ["projectId", "project_id"],
    ...(kind === "deployment" ? [["userId", "user_id"]] : []),
  ]) {
    if (creating || Object.hasOwn(data, field!))
      values[column!] = addressId(data[field!]);
  }
  for (const field of ["from", "to"] as const)
    if (creating || Object.hasOwn(data, field))
      values[field] =
        kind === "deployment"
          ? timestampInstant(data[field])
          : calendarDay(data[field]);
  if (creating || Object.hasOwn(data, "note"))
    values.note = addressText(data.note, false, 255);
  if (kind === "unavailability" && (creating || Object.hasOwn(data, "reason")))
    values.reason = addressText(data.reason, true, 127);
  if (values.from !== undefined && values.to !== undefined)
    scheduleRange(values.from, values.to, kind);
  return values;
}
export function scheduleRange(
  from: unknown,
  to: unknown,
  kind: ScheduleKind,
): void {
  if (
    kind === "deployment"
      ? timestampMicros(timestampInstant(from)) >=
        timestampMicros(timestampInstant(to))
      : calendarDay(from) > calendarDay(to)
  )
    throw new InvalidProtectedData();
}
export function schedulePayload(
  input: unknown,
  object: string,
  project: string,
): SchedulePayload {
  const hasTitle =
    input !== null &&
    typeof input === "object" &&
    Object.hasOwn(input, "projectTitle");
  const value = record(input, [
      "format",
      "row",
      ...(hasTitle ? ["projectTitle"] : []),
    ]),
    row = decodeBusinessRow(value.row);
  const kind =
    row.table === SCHEDULE_TABLES.deployment
      ? "deployment"
      : row.table === SCHEDULE_TABLES.unavailability
        ? "unavailability"
        : null;
  if (
    !kind ||
    value.format !== "sortsys-project-schedule-v1" ||
    publicId(row.values.project_id) !== project
  )
    throw new InvalidProtectedData();
  addressId(publicId(row.values.id));
  const prefix = `${scheduleCollection(project).prefix}${kind}:${publicId(row.values.id)}:`;
  if (!object.startsWith(prefix)) throw new InvalidProtectedData();
  addressId(object.slice(prefix.length));
  if (kind === "deployment") addressId(publicId(row.values.user_id));
  else {
    if (row.values.created_by_user_id !== null)
      addressId(publicId(row.values.created_by_user_id));
    addressText(row.values.reason, true, 127);
  }
  scheduleRange(row.values.from, row.values.to, kind);
  const projectTitle = hasTitle
    ? addressText(value.projectTitle, true, 127)
    : undefined;
  return {
    format: value.format,
    row,
    ...(projectTitle ? { projectTitle } : {}),
  };
}
export const SCHEDULE_MODEL = defineDataModel<SchedulePayload>({
  name: "project-schedule",
  tables: Object.values(SCHEDULE_TABLES),
  externalReferences: ["projects", "users"],
  decode: projectModuleDecoder(scheduleCollection, schedulePayload),
});
export const scheduleRequest = (project: string) => ({
  model: SCHEDULE_MODEL,
  area: scheduleCollection(project),
});
export function scheduleVersion(document: {
  id: string;
  revision: string;
}): string {
  return `${document.id}@${document.revision}`;
}
export function wireSchedule(payload: SchedulePayload, version: string) {
  const r = payload.row.values,
    deployment = payload.row.table === SCHEDULE_TABLES.deployment;
  return {
    id: publicId(r.id),
    projectId: publicId(r.project_id),
    ...(payload.projectTitle ? { projectTitle: payload.projectTitle } : {}),
    from: new Date(`${r.from}${deployment ? "" : "T00:00:00.000Z"}`),
    to: new Date(`${r.to}${deployment ? "" : "T00:00:00.000Z"}`),
    note: r.note as string | null,
    createdAt: new Date(r.created_at as string),
    modifiedAt: new Date(r.modified_at as string),
    revision: version,
    ...(deployment
      ? { userId: publicId(r.user_id) }
      : {
          reason: r.reason as string,
          createdByUserId:
            r.created_by_user_id === null
              ? null
              : publicId(r.created_by_user_id),
        }),
  };
}

import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { preferenceCollection, preferenceDomain } from "./preferenceData";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import type { Collection } from "./protectedObjects";
import { timestampInstant, timestampMicros } from "./timestamps";
import { defineDataModel } from "./runtime/model";

export const PERSONAL_HISTORY_QUERIES = new Set([
  "personalization.visits.list",
  "personalization.actions.list",
  "personalization.dashboard.pins.get",
]);
export const PERSONAL_HISTORY_MUTATIONS = new Set([
  "personalization.visits.append",
  "personalization.actions.append",
  "personalization.dashboard.pins.pin",
  "personalization.dashboard.pins.unpin",
  "personalization.dashboard.pins.move",
  "personalization.dashboard.pins.import",
]);
export const HISTORY_LIMITS = { visits: 100, actions: 200 } as const;
export type HistoryKind = keyof typeof HISTORY_LIMITS;
export type DashboardPin = {
  path: string;
  title: string | null;
  visitedAt: Date;
};
type Pin = Omit<DashboardPin, "visitedAt"> & { visitedAt: string };
export type HistoryPayload = {
  format: "sortsys-personal-history-v1";
  subject: string;
  kind: HistoryKind;
  rows: BusinessRow[];
};
export type PinsPayload = {
  format: "sortsys-dashboard-pins-v1";
  subject: string;
  importedLocal: boolean;
  entries: Pin[];
};
export type PersonalPayload = HistoryPayload | PinsPayload;
const table = (kind: HistoryKind) =>
  kind === "visits" ? "user_visit_history" : "user_action_history";
export const historyTimestamp = (kind: HistoryKind) =>
  kind === "visits" ? "visited_at" : "used_at";
export function historyCollection(subject: string): Collection {
  const area = preferenceCollection(subject);
  return { ...area, prefix: area.prefix + "history:" };
}
export function historyObject(
  subject: string,
  kind: HistoryKind | "pins",
): string {
  return historyCollection(subject).prefix + kind;
}

function text(input: unknown, limit: number, required = false): string | null {
  if (input === null || input === undefined) {
    if (required) throw new InvalidProtectedData();
    return null;
  }
  if (typeof input !== "string") throw new InvalidProtectedData();
  const value = input.trim();
  if (new TextEncoder().encode(value).length > limit || (required && !value))
    throw new InvalidProtectedData();
  return value || null;
}
/** Histories are navigation targets, not arbitrary links. Recheck migrated and
 * remote payloads as well as form input before passing them to React Router. */
export function historyPath(input: unknown, optional = false): string | null {
  const value = text(input, 512, !optional);
  if (value === null) return null;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value) ||
    new URL(value, "https://sortsys.invalid").origin !==
      "https://sortsys.invalid"
  )
    throw new InvalidProtectedData();
  return value;
}
export function visitInput(input: unknown) {
  const value = partialAddressRecord(input, ["path", "title"]);
  return { path: historyPath(value.path)!, title: text(value.title, 160) };
}
export function actionInput(input: unknown) {
  const value = partialAddressRecord(input, ["actionId", "label", "href"]);
  return {
    actionId: text(value.actionId, 128, true)!,
    label: text(value.label, 160, true)!,
    href: historyPath(value.href, true),
  };
}
export function dashboardPin(input: unknown): Pin {
  const value = record(input, ["path", "title", "visitedAt"]);
  const visit = visitInput({ path: value.path, title: value.title });
  return { ...visit, visitedAt: timestampInstant(value.visitedAt) };
}
export function recentHistory(
  rows: readonly BusinessRow[],
  kind: HistoryKind,
): BusinessRow[] {
  const field = historyTimestamp(kind);
  return [...rows]
    .sort((left, right) => {
      const leftTimestamp = timestampMicros(left.values[field] as string);
      const rightTimestamp = timestampMicros(right.values[field] as string);
      if (leftTimestamp > rightTimestamp) return -1;
      if (leftTimestamp < rightTimestamp) return 1;

      const leftId = BigInt(left.values.id as string);
      const rightId = BigInt(right.values.id as string);
      if (leftId > rightId) return -1;
      if (leftId < rightId) return 1;
      return 0;
    })
    .slice(0, HISTORY_LIMITS[kind]);
}
export function historyPayload(
  input: unknown,
  object: string,
  subject: string,
): HistoryPayload {
  const value = record(input, ["format", "subject", "kind", "rows"]);
  const kind = value.kind as HistoryKind;
  const area = historyCollection(subject);
  if (
    value.format !== "sortsys-personal-history-v1" ||
    value.subject !== subject ||
    !Object.hasOwn(HISTORY_LIMITS, kind) ||
    object !== area.prefix + kind ||
    !Array.isArray(value.rows) ||
    value.rows.length > HISTORY_LIMITS[kind]
  )
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  const owner = addressId(subject.slice(5));
  const rows = value.rows.map((input) => {
    const row = decodeBusinessRow(input);
    if (
      row.table !== table(kind) ||
      row.values.user_id !== owner ||
      seen.has(row.values.id as string)
    )
      throw new InvalidProtectedData();
    seen.add(row.values.id as string);
    addressId(publicId(row.values.id));
    timestampInstant(row.values[historyTimestamp(kind)]);
    if (kind === "visits") {
      if (
        visitInput({ path: row.values.path, title: row.values.title }).path !==
        row.values.path
      )
        throw new InvalidProtectedData();
    } else {
      if (
        actionInput({
          actionId: row.values.action_id,
          label: row.values.label,
          href: row.values.href,
        }).href !== row.values.href
      )
        throw new InvalidProtectedData();
    }
    return row;
  });
  return {
    format: value.format,
    subject,
    kind,
    rows: recentHistory(rows, kind),
  };
}
export function pinsPayload(
  input: unknown,
  object: string,
  subject: string,
): PinsPayload {
  const value = record(input, [
    "format",
    "subject",
    "importedLocal",
    "entries",
  ]);
  if (
    value.format !== "sortsys-dashboard-pins-v1" ||
    value.subject !== subject ||
    object !== historyObject(subject, "pins") ||
    typeof value.importedLocal !== "boolean" ||
    !Array.isArray(value.entries) ||
    value.entries.length > 12
  )
    throw new InvalidProtectedData();
  const entries = value.entries.map(dashboardPin);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new InvalidProtectedData();
  return {
    format: value.format,
    subject,
    importedLocal: value.importedLocal,
    entries,
  };
}
export const PERSONAL_HISTORY_MODEL = defineDataModel<PersonalPayload>({
  name: "personal-history",
  tables: ["user_visit_history", "user_action_history"],
  externalReferences: ["users"],
  decode(value: unknown, object: string, area: Collection) {
    const subject = preferenceDomain(area.domain);
    if (
      !subject ||
      area.prefix !== historyCollection(subject).prefix ||
      area.scope !== preferenceCollection(subject).scope ||
      area.facet !== "master-data"
    )
      throw new InvalidProtectedData();
    return object === historyObject(subject, "pins")
      ? pinsPayload(value, object, subject)
      : historyPayload(value, object, subject);
  },
});

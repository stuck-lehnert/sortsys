import {
  absenceDomain,
  base64,
  bytes,
  digest,
  frame,
  InvalidProtectedData,
  record,
  revision,
  sign,
  sized,
  verify,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { calendarDay } from "./calendarDays";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import type { Collection } from "./protectedObjects";
import { timestampInstant } from "./timestamps";

export const ABSENCE_QUERIES = new Set(["users.vacations.list"]);
export const ABSENCE_MUTATIONS = new Set(
  ["create", "approve", "deny", "delete"].map(
    (action) => `users.vacations.${action}`,
  ),
);
type LegacyProof = { generation: string; signature: string } | null;
export type AbsenceRequest = {
  format: "sortsys-absence-request-v1";
  row: BusinessRow;
  legacy: LegacyProof;
};
export type AbsenceDecision = {
  format: "sortsys-absence-decision-v1";
  userId: string;
  id: string;
  requestSignature: string;
  status: "approved" | "denied";
  denialReason: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  modifiedAt: string;
  legacy: LegacyProof;
};
export function absenceCollection(user: string, decision = false): Collection {
  addressId(user);
  const scope = `absence:${user}`;
  const facet = decision ? "personnel" : "master-data";
  return {
    domain: `${scope}:${facet}`,
    scope,
    facet,
    prefix: `${scope}:${decision ? "decision" : "request"}:`,
  };
}
function legacyProof(input: unknown): LegacyProof {
  if (input === null) return null;
  const value = record(input, ["generation", "signature"]);
  revision(value.generation);
  sized(value.signature as string, 64);
  return {
    generation: value.generation as string,
    signature: value.signature as string,
  };
}
function boundId(object: string, user: string, decision: boolean): string {
  const prefix = absenceCollection(user, decision).prefix;
  if (!object.startsWith(prefix)) throw new InvalidProtectedData();
  const id = object.slice(prefix.length);
  addressId(id);
  return id;
}
export function absenceRequest(
  input: unknown,
  object: string,
  user: string,
): AbsenceRequest {
  const value = record(input, ["format", "row", "legacy"]);
  const row = decodeBusinessRow(value.row);
  const r = row.values;
  const legacy = legacyProof(value.legacy);
  if (
    value.format !== "sortsys-absence-request-v1" ||
    row.table !== "user_vacations" ||
    publicId(r.id) !== boundId(object, user, false) ||
    publicId(r.user_id) !== user ||
    r.status !== "requested" ||
    r.denial_reason !== null ||
    r.decided_by_user_id !== null ||
    r.decided_at !== null ||
    calendarDay(r.from) > calendarDay(r.to) ||
    !["vacation", "other"].includes(r.absence_type as string)
  )
    throw new InvalidProtectedData();
  if (r.absence_type === "vacation") {
    if (r.label !== null) throw new InvalidProtectedData();
  } else if (
    typeof r.label !== "string" ||
    !r.label.trim() ||
    r.label !== r.label.trim()
  ) {
    throw new InvalidProtectedData();
  }
  if (r.requested_by_user_id !== null)
    addressId(publicId(r.requested_by_user_id));
  else if (!legacy) throw new InvalidProtectedData();
  return { format: value.format, row, legacy };
}
export function absenceDecision(
  input: unknown,
  object: string,
  user: string,
): AbsenceDecision {
  const value = record(input, [
    "format",
    "userId",
    "id",
    "requestSignature",
    "status",
    "denialReason",
    "decidedByUserId",
    "decidedAt",
    "modifiedAt",
    "legacy",
  ]);
  const legacy = legacyProof(value.legacy);
  if (
    value.format !== "sortsys-absence-decision-v1" ||
    value.userId !== user ||
    value.id !== boundId(object, user, true) ||
    !["approved", "denied"].includes(value.status as string)
  )
    throw new InvalidProtectedData();
  sized(value.requestSignature as string, 64);
  if (value.decidedByUserId !== null) addressId(value.decidedByUserId);
  else if (!legacy) throw new InvalidProtectedData();
  if (value.decidedAt !== null) timestampInstant(value.decidedAt);
  else if (!legacy) throw new InvalidProtectedData();
  if (value.status === "approved") {
    if (value.denialReason !== null) throw new InvalidProtectedData();
  } else if (
    typeof value.denialReason !== "string" ||
    !value.denialReason.trim() ||
    value.denialReason.length > 255
  ) {
    throw new InvalidProtectedData();
  }
  return {
    format: value.format,
    userId: user,
    id: value.id as string,
    requestSignature: value.requestSignature as string,
    status: value.status as AbsenceDecision["status"],
    denialReason: value.denialReason as string | null,
    decidedByUserId: value.decidedByUserId as string | null,
    decidedAt: value.decidedAt as string | null,
    modifiedAt: timestampInstant(value.modifiedAt),
    legacy,
  };
}
function modelArea(area: Collection, decision: boolean): string {
  const part = absenceDomain(area.domain);
  if (
    !part ||
    area.scope !== part.scope ||
    part.facet !== (decision ? "personnel" : "master-data") ||
    area.facet !== part.facet ||
    area.prefix !== absenceCollection(part.user, decision).prefix
  )
    throw new InvalidProtectedData();
  return part.user;
}
// These documents jointly form a vacation row. Keeping them out of a partial
// SQL table avoids exposing a requested status where a decision is unreadable.
export const ABSENCE_REQUEST_MODEL = defineDataModel<AbsenceRequest>({
  name: "absence-requests",
  tables: [],
  sources: () => [],
  decode: (value, object, area) =>
    absenceRequest(value, object, modelArea(area, false)),
  opened(value, object) {
    if (
      !value.legacy &&
      object.envelope.revision !== "0" &&
      `user:${publicId(value.row.values.requested_by_user_id)}` !==
        object.envelope.author
    )
      throw new InvalidProtectedData();
    return value;
  },
});
export const ABSENCE_DECISION_MODEL = defineDataModel<AbsenceDecision>({
  name: "absence-decisions",
  tables: [],
  sources: () => [],
  decode: (value, object, area) =>
    absenceDecision(value, object, modelArea(area, true)),
  opened(value, object) {
    if (
      !value.legacy &&
      object.envelope.revision !== "0" &&
      `user:${value.decidedByUserId}` !== object.envelope.author
    )
      throw new InvalidProtectedData();
    return value;
  },
});
export const absenceRequestArea = (user: string) => ({
  model: ABSENCE_REQUEST_MODEL,
  area: absenceCollection(user),
});
export const absenceDecisionArea = (user: string) => ({
  model: ABSENCE_DECISION_MODEL,
  area: absenceCollection(user, true),
});

export function absenceInput(input: unknown) {
  const value = partialAddressRecord(input, [
    "from",
    "to",
    "type",
    "label",
    "note",
  ]);
  const from = calendarDay(value.from);
  const to = calendarDay(value.to);
  const type = value.type ?? "vacation";
  if (from > to || !["vacation", "other"].includes(type as string))
    throw new InvalidProtectedData();
  if (type === "vacation" && value.label != null)
    throw new InvalidProtectedData();
  return {
    from,
    to,
    absence_type: type as "vacation" | "other",
    label: type === "vacation" ? null : addressText(value.label, true, 63),
    note: addressText(value.note, false, 255),
  };
}
export function absenceState(
  request: AbsenceRequest,
  sourceSignature: string,
  decision?: AbsenceDecision,
) {
  if (
    decision &&
    (decision.userId !== publicId(request.row.values.user_id) ||
      decision.id !== publicId(request.row.values.id) ||
      decision.requestSignature !== sourceSignature)
  )
    throw new InvalidProtectedData();
  return decodeBusinessRow({
    ...request.row,
    values: {
      ...request.row.values,
      ...(decision
        ? {
            status: decision.status,
            denial_reason: decision.denialReason,
            decided_by_user_id:
              decision.decidedByUserId === null
                ? null
                : addressId(decision.decidedByUserId),
            decided_at: decision.decidedAt,
            modified_at: decision.modifiedAt,
          }
        : {}),
    },
  });
}
async function legacyFrame(
  value: AbsenceRequest | AbsenceDecision,
  tenant: string,
  generation: string,
) {
  const decision = value.format === "sortsys-absence-decision-v1";
  const user = decision ? value.userId : publicId(value.row.values.user_id);
  const id = decision ? value.id : publicId(value.row.values.id);
  return frame("sortsys/absence-source/v1", [
    tenant,
    absenceCollection(user, decision).prefix + id,
    generation,
    await digest(bytes(JSON.stringify({ ...value, legacy: null }))),
  ]);
}
export async function attestLegacyAbsence(
  value: AbsenceRequest | AbsenceDecision,
  tenant: string,
  generation: string,
  authority: CryptoKey,
): Promise<AbsenceRequest | AbsenceDecision> {
  revision(generation);
  const placeholder = { generation, signature: base64(new Uint8Array(64)) };
  const decision = value.format === "sortsys-absence-decision-v1";
  const user = decision ? value.userId : publicId(value.row.values.user_id);
  const id = decision ? value.id : publicId(value.row.values.id);
  const object = absenceCollection(user, decision).prefix + id;
  const normalized = decision
    ? absenceDecision({ ...value, legacy: placeholder }, object, user)
    : absenceRequest({ ...value, legacy: placeholder }, object, user);
  return {
    ...normalized,
    legacy: {
      generation,
      signature: await sign(
        authority,
        await legacyFrame(normalized, tenant, generation),
      ),
    },
  };
}
export async function verifyLegacyAbsence(
  value: AbsenceRequest | AbsenceDecision,
  tenant: string,
  authority: (generation: string) => CryptoKey,
): Promise<void> {
  if (value.legacy)
    await verify(
      authority(value.legacy.generation),
      value.legacy.signature,
      await legacyFrame(value, tenant, value.legacy.generation),
    );
}

type Range = { from: string; to: string };
function businessDays(from: number, to: number): number {
  if (from > to) return 0;
  const days = to - from + 1;
  const weeks = Math.floor(days / 7);
  let count = weeks * 5;
  for (let offset = 0; offset < days % 7; offset++) {
    const weekday = (((from + offset + 4) % 7) + 7) % 7;
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}
export function vacationUsage(
  request: Range,
  approved: readonly Range[],
  allowance: number | null,
) {
  const day = (value: string) =>
    Math.floor(Date.parse(calendarDay(value)) / 86400000);
  const intervals = approved
    .map((range) => [day(range.from), day(range.to)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of intervals) {
    if (range[0] > range[1]) throw new InvalidProtectedData();
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1] + 1)
      previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  const values = [];
  const from = day(request.from);
  const to = day(request.to);
  if (
    from > to ||
    (allowance !== null &&
      (!Number.isInteger(allowance) || allowance < 0 || allowance > 366))
  )
    throw new InvalidProtectedData();
  for (
    let year = Number(request.from.slice(0, 4));
    year <= Number(request.to.slice(0, 4));
    year++
  ) {
    const start = day(`${String(year).padStart(4, "0")}-01-01`);
    const end = day(`${String(year).padStart(4, "0")}-12-31`);
    const requestedFrom = Math.max(start, from);
    const requestedTo = Math.min(end, to);
    const requestedDays = businessDays(requestedFrom, requestedTo);
    if (!requestedDays) continue;
    let approvedDays = 0;
    let overlap = 0;
    for (const [begin, finish] of merged) {
      if (begin > end) break;
      approvedDays += businessDays(
        Math.max(begin, start),
        Math.min(finish, end),
      );
      overlap += businessDays(
        Math.max(begin, requestedFrom),
        Math.min(finish, requestedTo),
      );
    }
    values.push({
      year,
      allowanceDays: allowance,
      approvedDays,
      requestedDays,
      remainingAfterApproval:
        allowance === null
          ? null
          : allowance - approvedDays - requestedDays + overlap,
    });
  }
  return values;
}

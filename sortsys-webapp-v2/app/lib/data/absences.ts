import type { Client } from "@sortsys/v2-client";
import {
  absenceDomain,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import {
  ABSENCE_MUTATIONS,
  ABSENCE_QUERIES,
  absenceCollection,
  absenceDecisionArea,
  absenceInput,
  absenceRequestArea,
  absenceState,
  vacationUsage,
  verifyLegacyAbsence,
  type AbsenceDecision,
  type AbsenceRequest,
} from "./absenceData";
import { commitProtectedWrites, ProtectedWriteConflict } from "./atomicWrites";
import { calendarDay } from "./calendarDays";
import type { DuckDriver } from "./database";
import { personnelDomain, personnelRequest } from "./personnelData";
import { newProductRowId, publicId } from "./products";
import { readableAreas } from "./readableAreas";
import { required } from "./protectedObjects";
import { createBusinessRow } from "./rowCodec";
import { acquireDataRuntime } from "./runtime/session";
import type { DataView } from "./runtime/runtime";

type Pair = {
  user: string;
  request: ReturnType<typeof absenceRequestArea>;
  decision: ReturnType<typeof absenceDecisionArea>;
};
type Document<T> = {
  id: string;
  signature: string | undefined;
  revision: string;
  value: T;
};
function version(
  request: Document<AbsenceRequest>,
  decision?: Document<AbsenceDecision>,
) {
  return `${request.signature}.${decision?.signature ?? "pending"}`;
}
function find(view: DataView, pairs: Pair[], id: string) {
  const values = pairs.flatMap((pair) =>
    view
      .documents(pair.request)
      .filter((doc) => publicId(doc.value.row.values.id) === id)
      .map((doc) => ({
        pair,
        request: doc,
        decision: view
          .documents(pair.decision)
          .find((item) => item.value.id === id),
      })),
  );
  if (values.length !== 1) throw new InvalidProtectedData();
  return values[0]!;
}
export function createProtectedAbsences(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const verified = new Set<string>();
  async function selection(user?: string) {
    if (user !== undefined) addressId(user);
    const areas = await readableAreas(client, signal, (domain) => {
      const part = absenceDomain(domain);
      return part && (!user || part.user === user)
        ? absenceCollection(part.user, part.facet === "personnel")
        : null;
    });
    live();
    const domains = new Set(areas.map((area) => area.domain));
    const users = [
      ...new Set(areas.map((area) => absenceDomain(area.domain)!.user)),
    ];
    const pairs = users
      .filter(
        (user) =>
          domains.has(absenceCollection(user).domain) &&
          domains.has(absenceCollection(user, true).domain),
      )
      .map((user) => ({
        user,
        request: absenceRequestArea(user),
        decision: absenceDecisionArea(user),
      }));
    if (user && !pairs.length) throw new InvalidProtectedData();
    return pairs;
  }
  const requests = (pairs: Pair[]) =>
    pairs.flatMap((pair) => [pair.request, pair.decision]);
  async function check(
    documents: Document<AbsenceRequest | AbsenceDecision>[],
  ) {
    if (
      !documents.some(
        (doc) => doc.value.legacy && !verified.has(doc.signature!),
      )
    )
      return;
    const history = await trustedHistory(client);
    live();
    for (const doc of documents)
      if (doc.value.legacy && !verified.has(doc.signature!)) {
        if (!doc.signature) throw new InvalidProtectedData();
        await verifyLegacyAbsence(
          doc.value,
          account!.tenant,
          history.authority,
        );
        live();
        verified.add(doc.signature);
      }
  }
  function current(
    view: DataView,
    pairs: Pair[],
    id: string,
    expected: unknown,
  ) {
    const result = find(view, pairs, id);
    if (
      expected !== undefined &&
      (typeof expected !== "string" ||
        expected !== version(result.request, result.decision))
    )
      throw new ProtectedWriteConflict();
    absenceState(
      result.request.value,
      result.request.signature!,
      result.decision?.value,
    );
    return result;
  }
  function decide(
    user: string,
    id: string,
    requestSignature: string,
    status: AbsenceDecision["status"],
    reason: string | null,
    actor: string,
  ): AbsenceDecision {
    const now = new Date().toISOString();
    return {
      format: "sortsys-absence-decision-v1",
      userId: user,
      id,
      requestSignature,
      status,
      denialReason: reason,
      decidedByUserId: actor,
      decidedAt: now,
      modifiedAt: now,
      legacy: null,
    };
  }
  return {
    close() {
      verified.clear();
      lease.close();
    },
    async refresh() {
      live();
      runtime.revalidate();
    },
    async query(path: string, input: unknown) {
      live();
      if (!ABSENCE_QUERIES.has(path)) throw new InvalidProtectedData();
      const data = partialAddressRecord(input ?? {}, [
        "from",
        "to",
        "userId",
        "includeDenied",
      ]);
      if (data.userId != null) addressId(data.userId);
      if (
        data.includeDenied !== undefined &&
        typeof data.includeDenied !== "boolean"
      )
        throw new InvalidProtectedData();
      const from = data.from == null ? null : calendarDay(data.from);
      const to = data.to == null ? null : calendarDay(data.to);
      if (from && to && from > to) throw new InvalidProtectedData();
      const pairs = await selection(
        (data.userId as string | undefined) ?? undefined,
      );
      const selected = requests(pairs);
      const ids = new Set(pairs.map((pair) => pair.user));
      const profiles = await readableAreas(client, signal, (domain) => {
        const part = personnelDomain(domain);
        return part?.facet === "scope" && ids.has(part.id)
          ? personnelRequest(part.id, "scope").area
          : null;
      });
      live();
      const allowances = profiles.map((area) =>
        personnelRequest(personnelDomain(area.domain)!.id, "scope"),
      );
      const result = await runtime.read(
        [...selected, ...allowances],
        async (view) => {
          await check(
            pairs.flatMap((pair) => [
              ...view.documents(pair.request),
              ...view.documents(pair.decision),
            ]),
          );
          const all = pairs.flatMap((pair) =>
            view.documents(pair.request).map((request) => {
              const decision = view
                .documents(pair.decision)
                .find(
                  (doc) =>
                    doc.value.id === publicId(request.value.row.values.id),
                );
              const row = absenceState(
                request.value,
                request.signature!,
                decision?.value,
              );
              return { pair, request, decision, row: row.values };
            }),
          );
          return all
            .filter(
              ({ row }) =>
                (!from || (row.to as string) >= from) &&
                (!to || (row.from as string) <= to) &&
                (data.includeDenied !== false || row.status !== "denied"),
            )
            .sort((left, right) => {
              const dateOrder = (right.row.from as string).localeCompare(
                left.row.from as string,
              );
              if (dateOrder !== 0) return dateOrder;

              const leftId = BigInt(left.row.id as string);
              const rightId = BigInt(right.row.id as string);
              if (leftId > rightId) return -1;
              if (leftId < rightId) return 1;
              return 0;
            })
            .map(({ pair, request, decision, row }) => {
              const canDecide = !decision && view.can(pair.decision, "approve");
              const profile = allowances.find(
                (item) => personnelDomain(item.area.domain)!.id === pair.user,
              );
              const allowance = profile
                ? view.documents(profile)[0]?.value.values
                    .vacation_days_per_year
                : null;
              let usage: ReturnType<typeof vacationUsage> = [];
              if (canDecide && row.absence_type === "vacation") {
                const approvedVacations = all
                  .filter(
                    (entry) =>
                      entry.pair.user === pair.user &&
                      entry.row.status === "approved" &&
                      entry.row.absence_type === "vacation",
                  )
                  .map(({ row }) => ({
                    from: row.from as string,
                    to: row.to as string,
                  }));
                usage = vacationUsage(
                  { from: row.from as string, to: row.to as string },
                  approvedVacations,
                  allowance == null ? null : Number(allowance),
                );
              }
              return {
                id: publicId(row.id),
                userId: pair.user,
                from: new Date(`${row.from}T00:00:00Z`),
                to: new Date(`${row.to}T00:00:00Z`),
                type: row.absence_type as "vacation" | "other",
                label: row.label as string | null,
                status: row.status as "requested" | "approved" | "denied",
                note: row.note as string | null,
                denialReason: row.denial_reason as string | null,
                requestedByUserId:
                  row.requested_by_user_id === null
                    ? null
                    : publicId(row.requested_by_user_id),
                decidedByUserId:
                  row.decided_by_user_id === null
                    ? null
                    : publicId(row.decided_by_user_id),
                decidedAt:
                  row.decided_at === null
                    ? null
                    : new Date(row.decided_at as string),
                createdAt: new Date(row.created_at as string),
                modifiedAt: new Date(row.modified_at as string),
                revision: version(request, decision),
                canApprove: canDecide,
                canDeny: canDecide,
                canDelete:
                  view.can(pair.request, "delete") &&
                  (!decision || view.can(pair.decision, "delete")),
                vacationUsage: usage,
              };
            });
        },
      );
      live();
      return result;
    },
    async mutate(path: string, input: unknown) {
      live();
      if (!ABSENCE_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path.endsWith(".create");
      const deleting = path.endsWith(".delete");
      const denying = path.endsWith(".deny");
      const data = partialAddressRecord(
        input,
        creating
          ? ["operationId", "userId", "from", "to", "type", "label", "note"]
          : ["id", "expectedRevision", ...(denying ? ["reason"] : [])],
      );
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const actor = session.user.id;
      if (creating) {
        const user = data.userId == null ? actor : (data.userId as string);
        addressId(user);
        const pairs = await selection(user);
        const pair = pairs[0]!;
        const selected = requests(pairs);
        const person = personnelRequest(user, "master-data");
        const { operationId, userId, ...fields } = data;
        const changes = absenceInput(fields);
        const id =
          operationId === undefined
            ? publicId(newProductRowId())
            : (operationId as string);
        addressId(id);
        const existing = await runtime.read(selected, async (view) => {
          await check([
            ...view.documents(pair.request),
            ...view.documents(pair.decision),
          ]);
          return view
            .documents(pair.request)
            .some((doc) => publicId(doc.value.row.values.id) === id)
            ? current(view, pairs, id, undefined)
            : null;
        });
        if (existing) {
          const r = existing.request.value.row.values;
          if (
            existing.request.value.legacy ||
            r.requested_by_user_id !== addressId(actor) ||
            Object.entries(changes).some(
              ([column, value]) => r[column] !== value,
            )
          )
            throw new ProtectedWriteConflict();
          return { id, status: existing.decision?.value.status ?? "requested" };
        }
        const now = new Date().toISOString();
        const object = pair.request.area.prefix + id;
        const value: AbsenceRequest = {
          format: "sortsys-absence-request-v1",
          legacy: null,
          row: createBusinessRow("user_vacations", {
            id: addressId(id),
            user_id: addressId(user),
            requested_by_user_id: addressId(actor),
            decided_by_user_id: null,
            status: "requested",
            denial_reason: null,
            decided_at: null,
            ...changes,
            created_at: now,
            modified_at: now,
          }),
        };
        const source = await runtime.prepare([...selected, person], (tx) => {
          const profile = tx.row("users", { id: addressId(user) });
          if (
            profile.require("archived_at") ||
            profile.require("deactivated_at")
          )
            throw new InvalidProtectedData();
          tx.create(pair.request, object, value);
          return tx.can(pair.decision, "approve");
        });
        let decision: Awaited<ReturnType<typeof runtime.prepare>> | undefined;
        try {
          if (source.value) {
            const packet = source.groups
              .flatMap((group) => group.packets)
              .find((packet) => packet.envelope.object === object);
            if (!packet) throw new InvalidProtectedData();
            decision = await runtime.prepare(selected, (tx) =>
              tx.create(
                pair.decision,
                pair.decision.area.prefix + id,
                decide(
                  user,
                  id,
                  packet.envelope.signature,
                  "approved",
                  null,
                  actor,
                ),
              ),
            );
          }
          await commitProtectedWrites(
            client,
            [...source.groups, ...(decision?.groups ?? [])],
            signal,
            [...source.guards, ...(decision?.guards ?? [])],
          );
          live();
          return { id, status: source.value ? "approved" : "requested" };
        } finally {
          source.close();
          decision?.close();
        }
      }
      const id = data.id as string;
      addressId(id);
      const pairs = await selection();
      const selected = requests(pairs);
      await runtime.read(selected, async (view) =>
        check(
          pairs.flatMap((pair) => [
            ...view.documents(pair.request),
            ...view.documents(pair.decision),
          ]),
        ),
      );
      live();
      const reason = denying ? addressText(data.reason, true, 255) : null;
      await runtime.transaction(selected, async (tx) => {
        live();
        const entry = current(tx, pairs, id, data.expectedRevision);
        await check([
          entry.request,
          ...(entry.decision ? [entry.decision] : []),
        ]);
        live();
        if (deleting) {
          if (entry.decision) tx.require(entry.pair.decision, "delete");
          tx.delete(entry.pair.request, entry.request.id);
          return;
        }
        if (entry.decision) throw new ProtectedWriteConflict();
        tx.require(entry.pair.decision, "approve");
        tx.create(
          entry.pair.decision,
          entry.pair.decision.area.prefix + id,
          decide(
            entry.pair.user,
            id,
            entry.request.signature!,
            denying ? "denied" : "approved",
            reason,
            actor,
          ),
        );
      });
      live();
      return { success: true as const };
    },
  };
}

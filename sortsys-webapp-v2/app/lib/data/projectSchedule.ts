import { timestampInstant } from "./timestamps";
import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { ProtectedWriteConflict } from "./atomicWrites";
import { calendarDay } from "./calendarDays";
import type { DuckDriver } from "./database";
import { personnelRequest } from "./personnelData";
import { PROJECT_MODEL, projectCollection } from "./projectData";
import { newProductRowId, publicId } from "./products";
import { readableAreas } from "./readableAreas";
import { required } from "./protectedObjects";
import { decodeBusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView } from "./runtime/runtime";
import {
  SCHEDULE_MODEL,
  SCHEDULE_QUERIES,
  SCHEDULE_MUTATIONS,
  SCHEDULE_TABLES,
  scheduleChanges,
  scheduleCollection,
  scheduleDomain,
  scheduleObject,
  schedulePayload,
  scheduleRange,
  scheduleRequest,
  scheduleVersion,
  wireSchedule,
  type ScheduleKind,
  type SchedulePayload,
} from "./projectScheduleData";
import { timestampMicros } from "./timestamps";
import { readOwnAssignments } from "./planningRecipients";

function find(
  view: DataView,
  requests: readonly DataRequest<SchedulePayload>[],
  kind: ScheduleKind,
  id: string,
) {
  const matches = requests.flatMap((request) =>
    view
      .documents(request)
      .filter(
        (doc) =>
          doc.value.row.table === SCHEDULE_TABLES[kind] &&
          publicId(doc.value.row.values.id) === id,
      )
      .map((doc) => ({ ...doc, request })),
  );
  if (matches.length !== 1) throw new InvalidProtectedData();
  return matches[0]!;
}
function expected(
  input: unknown,
  document: { id: string; revision: string },
): void {
  if (input === undefined) return;
  if (typeof input !== "string" || input !== scheduleVersion(document))
    throw new ProtectedWriteConflict();
}
export function createProtectedProjectSchedule(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    { runtime, live } = lease;
  async function requests(project?: string, requireArea = true) {
    if (project !== undefined) addressId(project);
    const areas = await readableAreas(client, signal, (domain) => {
      const id = scheduleDomain(domain);
      return id && (!project || project === id) ? scheduleCollection(id) : null;
    });
    live();
    if (requireArea && project && !areas.length)
      throw new InvalidProtectedData();
    return areas.map((area) => ({ model: SCHEDULE_MODEL, area }));
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate();
    },
    async query(path: string, input: unknown) {
      live();
      if (!SCHEDULE_QUERIES.has(path)) throw new InvalidProtectedData();
      const kind: ScheduleKind =
        path === "projects.deployments.list" ? "deployment" : "unavailability";
      const data = partialAddressRecord(input ?? {}, [
        "projectId",
        "from",
        "to",
        ...(kind === "deployment" ? ["userId", "since"] : []),
      ]);
      if (data.projectId != null) addressId(data.projectId);
      if (data.userId != null) addressId(data.userId);
      const from =
        data.from == null && kind !== "deployment"
          ? null
          : kind === "deployment"
            ? timestampInstant(data.from)
            : calendarDay(data.from);
      const to =
        data.to == null && kind !== "deployment"
          ? null
          : kind === "deployment"
            ? timestampInstant(data.to)
            : calendarDay(data.to);
      if (from && to) scheduleRange(from, to, kind);
      const since =
          data.since == null
            ? null
            : timestampMicros(timestampInstant(data.since)),
        selected = await requests(
          (data.projectId as string | undefined) ?? undefined,
          kind !== "deployment",
        );
      const [ordinary, own] = await Promise.all([
        runtime.read(selected, (view) =>
          selected.flatMap((request) => view.documents(request)),
        ),
        kind === "deployment"
          ? readOwnAssignments(
              client,
              signal,
              (data.projectId as string | undefined) ?? undefined,
            )
          : [],
      ]);
      live();
      const documents = new Map<
        string,
        {
          id: string;
          revision: string;
          signature?: string;
          value: SchedulePayload;
        }
      >(ordinary.map((document) => [document.id, document]));
      for (const document of own) {
        const existing = documents.get(document.id);
        if (
          existing &&
          (existing.revision !== document.revision ||
            existing.signature !== document.signature)
        )
          throw new ProtectedWriteConflict();
        if (!existing) documents.set(document.id, document);
      }
      const rowIds = new Set<string>();
      for (const document of documents.values()) {
        const id = `${document.value.row.table}:${publicId(document.value.row.values.id)}`;
        if (rowIds.has(id)) throw new ProtectedWriteConflict();
        rowIds.add(id);
      }
      const values = [...documents.values()]
        .filter(({ value }) => {
          const r = value.row.values;
          if (
            value.row.table !== SCHEDULE_TABLES[kind] ||
            (data.userId != null && publicId(r.user_id) !== data.userId) ||
            (since !== null &&
              timestampMicros(r.modified_at as string) <= since)
          )
            return false;
          return kind === "deployment"
            ? timestampMicros(r.to as string) > timestampMicros(from!) &&
                timestampMicros(r.from as string) < timestampMicros(to!)
            : (!from || (r.to as string) >= from) &&
                (!to || (r.from as string) <= to);
        })
        .sort((a, b) => {
          const first = a.value.row.values,
            second = b.value.row.values;
          const diff =
            kind === "deployment"
              ? timestampMicros(second.from as string) -
                timestampMicros(first.from as string)
              : (second.from as string).localeCompare(first.from as string);
          if (diff < 0) return -1;
          if (diff > 0) return 1;
          const firstId = addressId(publicId(first.id));
          const secondId = addressId(publicId(second.id));
          if (firstId === secondId) return 0;
          return secondId < firstId ? -1 : 1;
        })
        .map((document) =>
          wireSchedule(document.value, scheduleVersion(document)),
        );
      live();
      return values;
    },
    async mutate(path: string, input: unknown) {
      live();
      if (!SCHEDULE_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const kind: ScheduleKind = path.startsWith("projects.deployments.")
          ? "deployment"
          : "unavailability",
        creating = path.endsWith(".create"),
        deleting = path.endsWith(".delete");
      const data = partialAddressRecord(
        input,
        creating
          ? [
              "operationId",
              "projectId",
              "from",
              "to",
              "note",
              ...(kind === "deployment" ? ["userId"] : ["reason"]),
            ]
          : ["id", "expectedRevision", ...(!deleting ? ["data"] : [])],
      );
      const id = creating
        ? data.operationId === undefined
          ? publicId(newProductRowId())
          : (data.operationId as string)
        : (data.id as string);
      addressId(id);
      const { operationId, ...createInput } = data;
      const changes = deleting
        ? {}
        : scheduleChanges(creating ? createInput : data.data, kind, creating);
      if (!creating && !deleting && !Object.keys(changes).length)
        throw new InvalidProtectedData();
      const available = await requests(),
        baseline = creating
          ? null
          : await runtime.read(available, (view) =>
              find(view, available, kind, id),
            );
      live();
      if (baseline) expected(data.expectedRevision, baseline);
      const project = publicId(
          changes.project_id ?? baseline!.value.row.values.project_id,
        ),
        target = scheduleRequest(project);
      if (
        !available.some((request) => request.area.domain === target.area.domain)
      )
        throw new InvalidProtectedData();
      const moving =
        baseline !== null &&
        baseline.request.area.domain !== target.area.domain;
      const checkProject = creating || moving,
        checkUser =
          !deleting &&
          kind === "deployment" &&
          (creating ||
            (changes.user_id !== undefined &&
              changes.user_id !== baseline!.value.row.values.user_id));
      const projectRef = {
          model: PROJECT_MODEL,
          area: projectCollection(project),
        },
        userRef = checkUser
          ? personnelRequest(publicId(changes.user_id), "master-data")
          : null;
      const selected = [
        target,
        ...(moving ? [baseline!.request] : []),
        ...(checkProject ? [projectRef] : []),
        ...(userRef ? [userRef] : []),
      ];
      const session =
        creating && kind === "unavailability"
          ? await required(
              client.query("auth.sessionInfo", undefined, {
                strategy: "network-only",
              }),
            )
          : null;
      live();
      const storage = scheduleObject(
          project,
          kind,
          id,
          moving ? publicId(newProductRowId()) : id,
        ),
        now = new Date().toISOString();
      await runtime.transaction(selected, (tx) => {
        live();
        if (
          checkProject &&
          !tx.documents(projectRef).some((doc) => doc.value.project)
        )
          throw new InvalidProtectedData();
        const projectTitle = checkProject
          ? tx.documents(projectRef).find((document) => document.value.project)
              ?.value.project?.values.title
          : baseline?.value.projectTitle;
        if (userRef) {
          const user = tx.row("users", { id: changes.user_id });
          if (user.require("archived_at") || user.require("deactivated_at"))
            throw new InvalidProtectedData();
        }
        if (creating) {
          const present = tx
            .documents(target)
            .filter(
              (doc) =>
                doc.value.row.table === SCHEDULE_TABLES[kind] &&
                publicId(doc.value.row.values.id) === id,
            );
          if (present.length) {
            if (
              present.length !== 1 ||
              Object.entries(changes).some(([column, value]) =>
                ["from", "to"].includes(column) && kind === "deployment"
                  ? timestampMicros(
                      present[0]!.value.row.values[column] as string,
                    ) !== timestampMicros(value as string)
                  : present[0]!.value.row.values[column] !== value,
              )
            )
              throw new ProtectedWriteConflict();
            return;
          }
          const row = decodeBusinessRow({
            format: "sortsys-row-v2",
            schema: businessSchema.fingerprint,
            table: SCHEDULE_TABLES[kind],
            values: {
              id: addressId(id),
              ...changes,
              ...(kind === "unavailability"
                ? { created_by_user_id: addressId(session!.user.id) }
                : {}),
              created_at: now,
              modified_at: now,
            },
          });
          tx.create(
            target,
            storage,
            schedulePayload(
              {
                format: "sortsys-project-schedule-v1",
                row,
                ...(projectTitle ? { projectTitle } : {}),
              },
              storage,
              project,
            ),
          );
          return;
        }
        const current = find(tx, [baseline!.request], kind, id);
        if (scheduleVersion(current) !== scheduleVersion(baseline!))
          throw new ProtectedWriteConflict();
        if (deleting) {
          tx.delete(baseline!.request, current.id);
          return;
        }
        const row = decodeBusinessRow({
          ...current.value.row,
          values: { ...current.value.row.values, ...changes, modified_at: now },
        });
        scheduleRange(row.values.from, row.values.to, kind);
        if (moving) {
          tx.delete(current.request, current.id);
          tx.create(
            target,
            storage,
            schedulePayload(
              {
                format: "sortsys-project-schedule-v1",
                row,
                ...(projectTitle ? { projectTitle } : {}),
              },
              storage,
              project,
            ),
          );
        } else
          tx.edit(current.request, current.id, (value) => {
            value.row = row;
          });
      });
      live();
      return creating ? { id } : { success: true as const };
    },
  };
}

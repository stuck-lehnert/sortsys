import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { existingAggregateRows } from "./aggregateRows";
import {
  checkExpectedRevision,
  commitProtectedWrites,
  ProtectedWriteConflict,
} from "./atomicWrites";
import type { DuckDriver } from "./database";
import {
  calendarDay,
  dailyCollection,
  dailyDomain,
  dailyPayload,
  DAILY_MODEL,
  DAILY_COST_MODEL,
  DAILY_MUTATIONS,
  DAILY_QUERIES,
  reportHours,
  reportSummary,
  reportWeather,
  wireDailyReport,
  type DailyCosts,
  type DailyPayload,
} from "./dailyReportData";
import { personnelRequest } from "./personnelData";
import {
  fileCollection,
  fileDomainId,
  filePayload,
  wireFile,
} from "./projectFileData";
import { PROJECT_MODEL, projectCollection } from "./projectData";
import { newProductRowId, publicId } from "./products";
import { readableAreas } from "./readableAreas";
import { required } from "./protectedObjects";
import { reportPage } from "./reportPage";
import { createBusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView } from "./runtime/runtime";

const FILES = defineDataModel({
  name: "daily-report-photo-files",
  tables: ["project_files"],
  externalReferences: ["projects", "users", "project_file_folders"],
  decode(
    value: unknown,
    object: string,
    area: import("./protectedObjects").Collection,
  ) {
    const id = fileDomainId(area.domain);
    if (
      !id ||
      area.scope !== `project:${id}` ||
      area.facet !== "attachment" ||
      area.prefix !== `${fileCollection(id).prefix}file:`
    )
      throw new InvalidProtectedData();
    return filePayload(value, object, id);
  },
});
const request = (project: string) => ({
  model: DAILY_MODEL,
  area: dailyCollection(project),
});
const costRequest = (project: string) => ({
  model: DAILY_COST_MODEL,
  area: dailyCollection(project, true),
});
const fileRequest = (project: string) => ({
  model: FILES,
  area: {
    ...fileCollection(project),
    prefix: `${fileCollection(project).prefix}file:`,
  },
});

function find(
  view: DataView,
  selected: DataRequest<DailyPayload>,
  day: string,
) {
  const found = view
    .documents(selected)
    .filter((document) => document.value.report?.values.day === day);
  if (found.length !== 1) throw new InvalidProtectedData();
  return found[0]!;
}
export function createProtectedDailyReports(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    { runtime, live } = lease;
  async function requests(project?: string) {
    if (project !== undefined) addressId(project);
    const areas = await readableAreas(client, signal, (domain) => {
      const part = dailyDomain(domain);
      if (part && (!project || part.projectId === project))
        return dailyCollection(part.projectId, part.costs);
      const id = fileDomainId(domain);
      return id && (!project || id === project) ? fileRequest(id).area : null;
    });
    live();
    const reports = areas
      .filter((area) => area.facet === "master-data")
      .map((area) => request(dailyDomain(area.domain)!.projectId));
    if (project && !reports.length) throw new InvalidProtectedData();
    const projects = new Set(
      reports.map((item) => dailyDomain(item.area.domain)!.projectId),
    );
    const costs = areas
      .filter(
        (area) =>
          area.facet === "calculation" &&
          projects.has(dailyDomain(area.domain)!.projectId),
      )
      .map((area) => costRequest(dailyDomain(area.domain)!.projectId));
    const files = areas
      .filter(
        (area) =>
          area.facet === "attachment" &&
          projects.has(fileDomainId(area.domain)!),
      )
      .map((area) => ({ model: FILES, area }));
    return { reports, costs, files, all: [...reports, ...costs, ...files] };
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.invalidate();
    },
    async query(path: string, input: unknown) {
      live();
      if (!DAILY_QUERIES.has(path)) throw new InvalidProtectedData();
      const listing = path === "projects.dailyReports.list",
        data = partialAddressRecord(
          input ?? {},
          listing
            ? ["projectId", "from", "to", "limit", "offset"]
            : ["projectId", "day"],
        );
      if (!listing || data.projectId != null) addressId(data.projectId);

      const { start, end, first, last } = reportPage(
        data.from,
        data.to,
        data.limit,
        data.offset,
      );
      const day = listing ? null : calendarDay(data.day);
      const selected = await requests(
        data.projectId == null ? undefined : (data.projectId as string),
      );
      const result = await runtime.read(selected.all, (view) => {
        const matches = selected.reports.flatMap((item) =>
          view.documents(item).flatMap((document) => {
            const report = document.value.report;
            if (!report) return [];

            const date = report.values.day as string;
            if (
              (day && date !== day) ||
              (start && date < start) ||
              (end && date > end)
            )
              return [];

            return [
              {
                document,
                report,
                date,
                projectId: BigInt(report.values.project_id as string),
                scope: item.area.scope,
              },
            ];
          }),
        );
        if (!listing && matches.length !== 1) throw new InvalidProtectedData();

        // Use the decoded UTC day and numeric project ID before building the
        // response, so reports outside this page never allocate work-hour rows.
        matches.sort((a, b) => {
          if (a.date !== b.date) return a.date > b.date ? -1 : 1;

          if (a.projectId === b.projectId) return 0;
          return a.projectId < b.projectId ? -1 : 1;
        });
        const page = matches.slice(first, last);
        if (!page.length) return [];

        const costScopes = new Set(selected.costs.map(({ area }) => area.scope));
        const costs = new Map(
          selected.costs
            .flatMap((item) => view.documents(item))
            .map((item) => [item.value.reportId, item]),
        );
        const files = new Map(
          selected.files
            .flatMap((item) => view.documents(item))
            .filter(
              (item) =>
                item.value.file?.values.kind === "image" &&
                item.value.file.values.status === "uploaded",
            )
            .map((item) => [publicId(item.value.file!.values.id), item]),
        );
        const values = page.map(({ document, report, scope }) => {
          const payload = document.value;
          const cost = costs.get(publicId(report.values.id));

          return {
            ...wireDailyReport(payload, cost?.value),
            revision: document.revision,
            ...(costScopes.has(scope)
              ? { costRevision: cost?.revision ?? "0" }
              : {}),
            photos: payload.photos.flatMap((photo) => {
              const file = files.get(publicId(photo.values.project_file_id));
              if (
                !file ||
                file.value.file?.values.project_id !== report.values.project_id
              )
                return [];

              return [wireFile(file.value, file.revision)];
            }),
          };
        });

        return listing ? values : values[0]!;
      });
      live();
      return result;
    },
    async mutate(path: string, input: unknown, cancellation?: AbortSignal) {
      const currentSignal = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      currentSignal.throwIfAborted();
      live();
      if (!DAILY_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const creating = path === "projects.dailyReports.create",
        updating = path === "projects.dailyReports.update",
        deleting = path === "projects.dailyReports.delete",
        photo = path.includes(".photos.");
      const data = partialAddressRecord(
        input,
        creating
          ? ["projectId", "day", "summary", "weather", "workHours"]
          : updating
            ? [
                "projectId",
                "day",
                "data",
                "expectedRevision",
                "expectedCostRevision",
              ]
            : [
                "projectId",
                "day",
                ...(photo ? ["fileId"] : []),
                "expectedRevision",
              ],
      );
      addressId(data.projectId);
      const projectId = data.projectId as string,
        day = calendarDay(data.day),
        selected = request(projectId);
      const changes = updating
        ? partialAddressRecord(data.data, [
            "day",
            "summary",
            "weather",
            "workHours",
          ])
        : creating
          ? data
          : {};
      const nextDay =
        changes.day === undefined ? day : calendarDay(changes.day);
      if (
        (creating || changes.day !== undefined) &&
        Date.parse(nextDay) > Date.now() + 6 * 60 * 60 * 1000
      )
        throw new InvalidProtectedData();
      const hours =
        creating || changes.workHours !== undefined
          ? reportHours(changes.workHours, creating)
          : undefined;
      const summary =
        creating || changes.summary !== undefined
          ? reportSummary(changes.summary)
          : undefined;
      const weather =
        creating || changes.weather !== undefined
          ? reportWeather(changes.weather ?? null)
          : undefined;
      const session = creating
        ? await required(
            client.query("auth.sessionInfo", undefined, {
              strategy: "network-only",
            }),
          )
        : null;
      live();
      const selectedAreas = await requests(projectId);
      live();
      const baseline = creating
        ? null
        : await runtime.read([selected], (view) => find(view, selected, day));
      const previous = baseline?.value,
        previousHours = existingAggregateRows(
          previous?.hours ?? [],
          hours ?? [],
        );
      // Replacing old lines without their stable IDs could silently erase an
      // unread cost fragment. Require the current form protocol for updates.
      if (
        !creating &&
        hours?.some((change) => !change.id) &&
        previous?.hours.length &&
        data.expectedRevision === undefined
      )
        throw new InvalidProtectedData();
      const users = [
        ...new Set(
          (hours ?? [])
            .filter(
              (change) =>
                change.userId &&
                (!change.id ||
                  previousHours.get(change.id)?.values.user_id !==
                    addressId(change.userId) ||
                  change.contractType === undefined),
            )
            .map((change) => change.userId!),
        ),
      ].map((id) => personnelRequest(id, "master-data"));
      const needsCosts = (hours ?? []).some(
        (change) =>
          change.costPerHour !== undefined &&
          (!creating || change.costPerHour !== null),
      );
      const money = needsCosts ? costRequest(projectId) : null;
      if (money && !selectedAreas.costs.length)
        throw new InvalidProtectedData();
      if (photo) addressId(data.fileId);
      const photoFiles =
        photo && path.endsWith(".add") ? fileRequest(projectId) : null;
      const project = creating
        ? { model: PROJECT_MODEL, area: projectCollection(projectId) }
        : null;
      const prepared = await runtime.prepare(
        [
          selected,
          ...users,
          ...(money ? [money] : []),
          ...(project ? [project] : []),
          ...(photoFiles ? [photoFiles] : []),
        ],
        (tx) => {
          const current = creating ? null : find(tx, selected, day);
          if (baseline)
            tx.expect(selected, baseline.id, { signature: baseline.signature });
          checkExpectedRevision(data.expectedRevision, current?.revision);
          if (
            creating &&
            tx
              .documents(selected)
              .some((document) => document.value.report?.values.day === day)
          )
            throw new ProtectedWriteConflict();
          if (
            project &&
            !tx.documents(project).some((document) => document.value.project)
          )
            throw new InvalidProtectedData();
          const id = current
              ? publicId(current.value.report!.values.id)
              : publicId(newProductRowId()),
            object = selected.area.prefix + id,
            now = new Date().toISOString();
          if (deleting) {
            tx.delete(selected, object);
            return { success: true as const };
          }
          let value: DailyPayload;
          const priceChanges = new Map<string, number | null>();
          const old = current?.value;
          const lines =
            hours === undefined
              ? old!.hours
              : hours.map((change) => {
                  const before = change.id
                      ? previousHours.get(change.id)
                      : undefined,
                    samePerson =
                      before?.values.user_id ===
                      (change.userId === null
                        ? null
                        : addressId(change.userId));
                  const person =
                    change.userId &&
                    users.some(
                      (item) =>
                        item.area.scope === `personnel:${change.userId}`,
                    )
                      ? tx.row("users", { id: addressId(change.userId) })
                      : null;
                  const line = createBusinessRow(
                    "daily_project_report_work_hours",
                    {
                      id: samePerson ? before!.values.id : newProductRowId(),
                      report_id: addressId(id),
                      user_id:
                        change.userId === null ? null : addressId(change.userId),
                      hours: change.hours,
                      cost_per_hour: null,
                      contract_type:
                        change.contractType ??
                        (samePerson
                          ? before?.values.contract_type
                          : person?.require("contract_type")) ??
                        "external",
                    },
                  );

                  if (
                    change.costPerHour !== undefined &&
                    (!creating || change.costPerHour !== null)
                  )
                    priceChanges.set(
                      publicId(line.values.id),
                      change.costPerHour,
                    );
                  return line;
                });
          let photos = old?.photos ?? [];
          if (photo) {
            const fileId = addressId(data.fileId);
            if (path.endsWith(".add")) {
              if (
                !tx
                  .documents(photoFiles!)
                  .some(
                    (document) =>
                      document.value.file?.values.id === fileId &&
                      document.value.file.values.kind === "image" &&
                      document.value.file.values.status === "uploaded",
                  )
              )
                throw new InvalidProtectedData();
              if (!photos.some((row) => row.values.project_file_id === fileId))
                photos = [
                  ...photos,
                  createBusinessRow("daily_project_report_files", {
                    report_id: addressId(id),
                    project_file_id: fileId,
                    created_at: now,
                  }),
                ];
            } else {
              if (!photos.some((row) => row.values.project_file_id === fileId))
                throw new InvalidProtectedData();
              photos = photos.filter(
                (row) => row.values.project_file_id !== fileId,
              );
            }
          }
          value = dailyPayload(
            {
              format: "sortsys-daily-report-v1",
              report: createBusinessRow(
                "daily_project_reports",
                old
                  ? {
                      ...old.report!.values,
                      day: nextDay,
                      ...(summary !== undefined ? { summary } : {}),
                      ...(weather !== undefined
                        ? {
                            weather:
                              weather === null ? null : JSON.stringify(weather),
                          }
                        : {}),
                    }
                  : {
                      id: addressId(id),
                      project_id: addressId(projectId),
                      day,
                      summary: summary ?? null,
                      weather: weather == null ? null : JSON.stringify(weather),
                      created_by_user_id: addressId(session!.user.id),
                      created_at: now,
                    },
              ),
              hours: lines,
              photos,
            },
            object,
            projectId,
          );
          if (creating) tx.create(selected, object, value);
          else if (JSON.stringify(value) !== JSON.stringify(current!.value))
            tx.edit(selected, object, (target) => Object.assign(target, value));
          if (money && priceChanges.size) {
            const costObject = money.area.prefix + id,
              old = tx
                .documents(money)
                .find((document) => document.id === costObject);
            checkExpectedRevision(data.expectedCostRevision, old?.revision);
            const costs = new Map(
              old?.value.costs.map((cost) => [cost.id, cost.costPerHour]),
            );
            for (const [id, cost] of priceChanges) costs.set(id, cost);
            const next: DailyCosts = {
              format: "sortsys-daily-costs-v1",
              projectId,
              reportId: id,
              costs: [...costs].map(([id, costPerHour]) => ({
                id,
                costPerHour,
              })),
            };
            if (old)
              tx.edit(money, costObject, (value) => Object.assign(value, next));
            else tx.create(money, costObject, next);
          }
          return { success: true as const };
        },
      );
      try {
        live();
        currentSignal.throwIfAborted();
        if (prepared.groups.length)
          await commitProtectedWrites(
            client,
            prepared.groups,
            currentSignal,
            prepared.guards,
          );
        live();
        return prepared.value;
      } finally {
        prepared.close();
      }
    },
  };
}

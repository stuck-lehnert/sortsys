import type { Client } from "@sortsys/v2-client";
import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { groupBy } from "../groupBy";
import { copyProtectedCollection } from "./copyCollection";
import type { BusinessDatabase } from "./database";
import {
  dailyCollection,
  dailyCosts,
  dailyPayload,
  type DailyCosts,
  type DailyPayload,
} from "./dailyReportData";
import { publicId, readBusinessRows } from "./products";
import { prepareOwnerCollections } from "./prepareCollections";
import { protectedCollections, type Collection } from "./protectedObjects";
import {
  regieCollection,
  regieHours,
  regiePayload,
  type RegieHours,
  type RegiePayload,
} from "./regieReportData";
import type { BusinessRow } from "./rowCodec";

type DecodeReport = (input: unknown, object: string, project: string) => unknown;
type ReportImport = {
  collection(project: string, details?: boolean): Collection;
  decode: readonly [main: DecodeReport, details: DecodeReport];
  payloads(
    report: BusinessRow,
    project: string,
    id: string,
  ):
    | readonly [DailyPayload, DailyCosts]
    | readonly [RegiePayload, RegieHours];
};

function groupRows(
  rows: readonly BusinessRow[],
  field: "project_id" | "report_id",
  owners: ReadonlySet<unknown> | ReadonlyMap<unknown, unknown>,
) {
  return groupBy(rows, (row) => {
    const owner = row.values[field];
    if (!owners.has(owner)) throw new InvalidProtectedData();

    return owner;
  });
}

async function copyReports(
  client: Client,
  subject: string,
  projects: readonly BusinessRow[],
  reports: readonly BusinessRow[],
  model: ReportImport,
  signal: AbortSignal,
) {
  const projectIds = new Set(projects.map(({ values }) => values.id));
  const byProject = groupRows(reports, "project_id", projectIds);

  // Empty projects participate so a replay cannot hide unexpected reports.
  const copies = projects.flatMap(({ values }) => {
    signal.throwIfAborted();

    const project = publicId(values.id);
    const entries = (byProject.get(values.id) ?? []).map((report) => {
      const id = publicId(report.values.id);
      return { id, payloads: model.payloads(report, project, id) };
    });

    return model.decode.map((decode, index) => {
      const area = model.collection(project, index === 1);

      return {
        area,
        rows: entries.map(({ id, payloads }) => ({
          id: area.prefix + id,
          value: payloads[index],
        })),
        validate: (value: unknown, object: string) =>
          decode(value, object, project),
      };
    });
  });

  if (!copies.length) return;

  await prepareOwnerCollections(
    client,
    subject,
    copies.map(({ area }) => area),
    signal,
  );

  // Share the verified context, but keep each facet's own guarded publication.
  const open = await protectedCollections(client, signal);
  for (const page of arrayBatches(copies, 16)) {
    signal.throwIfAborted();
    await open.prefetch(page.map(({ area }) => ({ area })));

    for (const { area, rows, validate } of page) {
      await copyProtectedCollection(
        client,
        area,
        rows,
        validate,
        signal,
        false,
        open,
      );
    }
  }
}

export async function prepareDailyReports(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const projects = await readBusinessRows(source, "projects");
  const reports = await readBusinessRows(source, "daily_project_reports");
  const hours = await readBusinessRows(source, "daily_project_report_work_hours");
  const photos = await readBusinessRows(source, "daily_project_report_files");
  const files = await readBusinessRows(source, "project_files");

  const projectsById = (rows: BusinessRow[]) =>
    new Map(rows.map(({ values }) => [values.id, values.project_id]));
  const projectByReport = projectsById(reports);
  const projectByFile = projectsById(files);
  const hoursByReport = groupRows(hours, "report_id", projectByReport);
  const photosByReport = groupRows(photos, "report_id", projectByReport);

  const foreignPhoto = photos.some(
    ({ values }) =>
      !projectByFile.has(values.project_file_id) ||
      projectByFile.get(values.project_file_id) !==
        projectByReport.get(values.report_id),
  );

  if (foreignPhoto) {
    throw new InvalidProtectedData();
  }

  await copyReports(client, subject, projects, reports, {
    collection: dailyCollection,
    decode: [dailyPayload, dailyCosts],
    payloads(report, projectId, reportId): [DailyPayload, DailyCosts] {
      const lines = hoursByReport.get(report.values.id) ?? [];

      return [
        {
          format: "sortsys-daily-report-v1",
          report,
          hours: lines.map((row) => ({
            ...row,
            values: { ...row.values, cost_per_hour: null },
          })),
          photos: photosByReport.get(report.values.id) ?? [],
        },
        {
          format: "sortsys-daily-costs-v1",
          projectId,
          reportId,
          costs: lines.map(({ values }) => ({
            id: publicId(values.id),
            costPerHour: values.cost_per_hour as number | null,
          })),
        },
      ];
    },
  }, signal);
}

export async function prepareRegieReports(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const projects = await readBusinessRows(source, "projects");
  const reports = await readBusinessRows(source, "regie_reports");
  const products = await readBusinessRows(source, "regie_report_products");
  const specials = await readBusinessRows(source, "regie_report_special_records");
  const hours = await readBusinessRows(source, "regie_report_work_hours");

  const reportIds = new Set(reports.map(({ values }) => values.id));
  const productsByReport = groupRows(products, "report_id", reportIds);
  const specialsByReport = groupRows(specials, "report_id", reportIds);
  const hoursByReport = groupRows(hours, "report_id", reportIds);

  await copyReports(client, subject, projects, reports, {
    collection: regieCollection,
    decode: [regiePayload, regieHours],
    payloads(report, projectId, reportId): [RegiePayload, RegieHours] {
      return [
        {
          format: "sortsys-regie-report-v1",
          report,
          products: productsByReport.get(report.values.id) ?? [],
          specials: specialsByReport.get(report.values.id) ?? [],
        },
        {
          format: "sortsys-regie-hours-v1",
          projectId,
          reportId,
          week: report.values.day as string,
          hours: hoursByReport.get(report.values.id) ?? [],
        },
      ];
    },
  }, signal);
}

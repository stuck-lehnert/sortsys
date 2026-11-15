import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import {
  dailyCollection,
  dailyCosts,
  dailyPayload,
  type DailyCosts,
  type DailyPayload,
} from "./dailyReportData";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";

export async function prepareDailyReports(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const projects = await readBusinessRows(source, "projects"),
    reports = await readBusinessRows(source, "daily_project_reports"),
    hours = await readBusinessRows(source, "daily_project_report_work_hours"),
    photos = await readBusinessRows(source, "daily_project_report_files"),
    files = await readBusinessRows(source, "project_files");
  const projectIds = new Set(projects.map((row) => row.values.id)),
    reportIds = new Map(reports.map((row) => [row.values.id, row])),
    fileIds = new Map(files.map((row) => [row.values.id, row]));
  if (
    reports.some((row) => !projectIds.has(row.values.project_id)) ||
    hours.some((row) => !reportIds.has(row.values.report_id)) ||
    photos.some(
      (row) =>
        !reportIds.has(row.values.report_id) ||
        fileIds.get(row.values.project_file_id)?.values.project_id !==
          reportIds.get(row.values.report_id)?.values.project_id,
    )
  )
    throw new InvalidProtectedData();
  await prepareOwnerCollections(
    client,
    subject,
    projects.flatMap((row) => [
      dailyCollection(publicId(row.values.id)),
      dailyCollection(publicId(row.values.id), true),
    ]),
    signal,
  );
  for (const project of projects) {
    signal.throwIfAborted();
    const projectId = publicId(project.values.id),
      area = dailyCollection(projectId),
      money = dailyCollection(projectId, true);
    const values: { id: string; value: DailyPayload }[] = [],
      prices: { id: string; value: DailyCosts }[] = [];
    for (const report of reports.filter(
      (row) => row.values.project_id === project.values.id,
    )) {
      const id = publicId(report.values.id),
        lines = hours.filter(
          (row) => row.values.report_id === report.values.id,
        );
      values.push({
        id: area.prefix + id,
        value: {
          format: "sortsys-daily-report-v1",
          report,
          hours: lines.map((row) => ({
            ...row,
            values: { ...row.values, cost_per_hour: null },
          })),
          photos: photos.filter(
            (row) => row.values.report_id === report.values.id,
          ),
        },
      });
      prices.push({
        id: money.prefix + id,
        value: {
          format: "sortsys-daily-costs-v1",
          projectId,
          reportId: id,
          costs: lines.map((row) => ({
            id: publicId(row.values.id),
            costPerHour: row.values.cost_per_hour as number | null,
          })),
        },
      });
    }
    await copyProtectedCollection(
      client,
      area,
      values,
      (value, object) => dailyPayload(value, object, projectId),
      signal,
    );
    await copyProtectedCollection(
      client,
      money,
      prices,
      (value, object) => dailyCosts(value, object, projectId),
      signal,
    );
  }
}

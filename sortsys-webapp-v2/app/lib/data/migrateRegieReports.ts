import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import {
  regieCollection,
  regieHours,
  regiePayload,
  type RegieHours,
  type RegiePayload,
} from "./regieReportData";

export async function prepareRegieReports(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const projects = await readBusinessRows(source, "projects"),
    reports = await readBusinessRows(source, "regie_reports"),
    products = await readBusinessRows(source, "regie_report_products"),
    specials = await readBusinessRows(source, "regie_report_special_records"),
    hours = await readBusinessRows(source, "regie_report_work_hours");
  const projectIds = new Set(projects.map((row) => row.values.id)),
    reportIds = new Set(reports.map((row) => row.values.id));
  if (
    reports.some((row) => !projectIds.has(row.values.project_id)) ||
    [...products, ...specials, ...hours].some(
      (row) => !reportIds.has(row.values.report_id),
    )
  )
    throw new InvalidProtectedData();
  await prepareOwnerCollections(
    client,
    subject,
    projects.flatMap((row) => [
      regieCollection(publicId(row.values.id)),
      regieCollection(publicId(row.values.id), true),
    ]),
    signal,
  );
  for (const project of projects) {
    signal.throwIfAborted();
    const projectId = publicId(project.values.id),
      area = regieCollection(projectId),
      times = regieCollection(projectId, true);
    const values: { id: string; value: RegiePayload }[] = [],
      timeValues: { id: string; value: RegieHours }[] = [];
    for (const report of reports.filter(
      (row) => row.values.project_id === project.values.id,
    )) {
      const id = publicId(report.values.id);
      values.push({
        id: area.prefix + id,
        value: {
          format: "sortsys-regie-report-v1",
          report,
          products: products.filter(
            (row) => row.values.report_id === report.values.id,
          ),
          specials: specials.filter(
            (row) => row.values.report_id === report.values.id,
          ),
        },
      });
      timeValues.push({
        id: times.prefix + id,
        value: {
          format: "sortsys-regie-hours-v1",
          projectId,
          reportId: id,
          week: report.values.day as string,
          hours: hours.filter(
            (row) => row.values.report_id === report.values.id,
          ),
        },
      });
    }
    await copyProtectedCollection(
      client,
      area,
      values,
      (value, object) => regiePayload(value, object, projectId),
      signal,
    );
    await copyProtectedCollection(
      client,
      times,
      timeValues,
      (value, object) => regieHours(value, object, projectId),
      signal,
    );
  }
}

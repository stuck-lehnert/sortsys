import type { RegieReport } from "~/type-helpers";

/** Resolve each project once, preserving report order and project-relative numbers. */
export async function buildRegieReportListExportRows(
  reports: RegieReport[],
  loadProjectTitle: (projectId: string) => Promise<string>,
) {
  const projectIds = [...new Set(reports.map(report => report.projectId))];
  const projects = await Promise.all(projectIds.map(async projectId => [
    projectId,
    await loadProjectTitle(projectId),
  ] as const));
  const titles = new Map(projects);
  return reports.map(report => ({ ...report, projectTitle: titles.get(report.projectId) ?? '' }));
}

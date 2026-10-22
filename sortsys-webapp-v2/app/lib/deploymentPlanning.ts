import type { Project } from "../type-helpers";

type PlanningRow = { id: string; label: string };
type PlanningProject = Pick<Project, "id" | "title" | "finishedAt">;

export function addRecentPlanningProjects(
  rows: readonly PlanningRow[],
  orderedProjects: readonly PlanningProject[],
): PlanningRow[] {
  const result = [...rows];
  const displayedIds = new Set(rows.map((row) => row.id));
  let added = 0;

  // The API orders projects by the reader's latest visible project activity.
  for (const project of orderedProjects) {
    if (project.finishedAt || displayedIds.has(project.id)) {
      continue;
    }

    result.push({ id: project.id, label: project.title });
    displayedIds.add(project.id);
    added += 1;

    if (added === 5) {
      break;
    }
  }

  return result;
}

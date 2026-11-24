import type { MyPublicFormContext } from "../components/MyForm";
import type { Project } from "../type-helpers";

type PlanningRow = { id: string; label: string };
type PlanningProject = Pick<Project, "id" | "title" | "finishedAt">;

export async function prefillPlanningSelection<T extends { id: string }>(
  form: Pick<MyPublicFormContext, "field">,
  name: string,
  id: string | null,
  available: readonly T[] | null | undefined,
  read: (id: string) => Promise<[T | null, Error | null]>,
): Promise<void> {
  if (!id) return;

  const field = form.field<T[]>(name);
  if (!field) return;

  const initial = field.getValue();
  if (initial.length) return;

  const cached = available?.find((item) => item.id === id);
  if (cached) {
    field.setValue([cached]);
    return;
  }

  const [item, error] = await read(id);
  if (error || item?.id !== id) return;

  // A different array also covers a selection that was deliberately cleared.
  if (form.field(name) === field && field.getValue() === initial) {
    field.setValue([item]);
  }
}

export function clipAssignments<T extends { from: Date; to: Date }>(
  assignments: readonly T[],
  windowStart: Date,
  windowEnd: Date,
) {
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();
  const segments: { item: T; start: Date; end: Date }[] = [];

  for (const item of assignments) {
    const start = Math.max(item.from.getTime(), startMs);
    const end = Math.min(item.to.getTime(), endMs);
    if (start < end) {
      segments.push({ item, start: new Date(start), end: new Date(end) });
    }
  }

  return segments;
}

export function addRecentPlanningProjects(
  rows: readonly PlanningRow[],
  orderedProjects: readonly PlanningProject[],
): PlanningRow[] {
  const result = [...rows];
  const displayedIds = new Set(rows.map((row) => row.id));
  let added = 0;

  // Keep the order supplied by projects.list({ orderBy: "activity" }).
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

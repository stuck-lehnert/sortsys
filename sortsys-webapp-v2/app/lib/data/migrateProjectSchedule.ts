import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import {
  SCHEDULE_TABLES,
  scheduleCollection,
  scheduleObject,
  schedulePayload,
  type ScheduleKind,
} from "./projectScheduleData";

export async function prepareProjectSchedule(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const projects = await readBusinessRows(source, "projects"),
    deployments = await readBusinessRows(source, "project_deployments"),
    periods = await readBusinessRows(source, "project_unavailability_periods"),
    users = await readBusinessRows(source, "users");
  const ids = new Set(projects.map((row) => row.values.id)),
    people = new Set(users.map((row) => row.values.id)),
    rows = [...deployments, ...periods];
  if (
    rows.some(
      (row) =>
        !ids.has(row.values.project_id) ||
        (row.table === SCHEDULE_TABLES.deployment &&
          !people.has(row.values.user_id)) ||
        (row.table === SCHEDULE_TABLES.unavailability &&
          row.values.created_by_user_id !== null &&
          !people.has(row.values.created_by_user_id)),
    )
  )
    throw new InvalidProtectedData();
  const plans = projects.map((project) => {
    const id = publicId(project.values.id),
      area = scheduleCollection(id);
    const values = rows
      .filter((row) => row.values.project_id === project.values.id)
      .map((row) => {
        const kind: ScheduleKind =
            row.table === SCHEDULE_TABLES.deployment
              ? "deployment"
              : "unavailability",
          object = scheduleObject(id, kind, publicId(row.values.id));
        return {
          id: object,
          value: schedulePayload(
            {
              format: "sortsys-project-schedule-v1",
              row,
              projectTitle: project.values.title,
            },
            object,
            id,
          ),
        };
      });
    return { id, area, values };
  });
  await prepareOwnerCollections(
    client,
    subject,
    plans.map((plan) => plan.area),
    signal,
  );
  for (const plan of plans) {
    signal.throwIfAborted();
    await copyProtectedCollection(
      client,
      plan.area,
      plan.values,
      (value, object) => schedulePayload(value, object, plan.id),
      signal,
    );
  }
}

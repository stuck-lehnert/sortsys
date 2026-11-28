import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { groupBy } from "../groupBy";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyOwnedAreas } from "./copyCollection";
import { publicId } from "./products";
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
  const projects = await readBusinessRows(source, "projects");
  const deployments = await readBusinessRows(source, SCHEDULE_TABLES.deployment);
  const periods = await readBusinessRows(source, SCHEDULE_TABLES.unavailability);
  const users = await readBusinessRows(source, "users");
  const ids = new Set(projects.map((row) => row.values.id));
  const people = new Set(users.map((row) => row.values.id));

  const byProject = groupBy([...deployments, ...periods], (row) => {
    const {
      project_id: project,
      user_id: user,
      created_by_user_id: creator,
    } = row.values;
    if (
      !ids.has(project) ||
      (row.table === SCHEDULE_TABLES.deployment && !people.has(user)) ||
      (row.table === SCHEDULE_TABLES.unavailability &&
        creator !== null &&
        !people.has(creator))
    )
      throw new InvalidProtectedData();

    return project;
  });

  const plans = projects.map((project) => {
    const id = publicId(project.values.id);
    const area = scheduleCollection(id);
    const validate = (value: unknown, object: string) =>
      schedulePayload(value, object, id);
    const rows = (byProject.get(project.values.id) ?? []).map((row) => {
      const kind: ScheduleKind =
        row.table === SCHEDULE_TABLES.deployment ? "deployment" : "unavailability";
      const object = scheduleObject(id, kind, publicId(row.values.id));
      const value = validate(
        {
          format: "sortsys-project-schedule-v1",
          row,
          projectTitle: project.values.title,
        },
        object,
      );
      return { id: object, value };
    });
    return { area, rows, validate };
  });

  await copyOwnedAreas(client, subject, plans, signal);
}

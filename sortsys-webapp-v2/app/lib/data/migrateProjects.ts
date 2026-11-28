import type { Client } from "@sortsys/v2-client";
import { groupBy } from "../groupBy";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { publicId } from "./products";
import { copyOwnedAreas } from "./copyCollection";
import { projectCollection, projectPayload, type ProjectPayload } from "./projectData";

export async function prepareProjects(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const projects = await readBusinessRows(source, "projects");
  const contacts = groupBy(
    await readBusinessRows(source, "project_contacts"),
    (row) => row.values.project_id,
  );

  const entries = projects.map((project) => {
    const id = publicId(project.values.id);
    const area = projectCollection(id);
    const value: ProjectPayload = {
      format: "sortsys-project-v1",
      project,
      contacts: contacts.get(project.values.id) ?? [],
    };
    return {
      area,
      rows: [{ id: area.prefix, value }],
      validate: (value: unknown, object: string) =>
        projectPayload(value, object, id),
    };
  });

  await copyOwnedAreas(client, subject, entries, signal);
}

import type { Client } from "@sortsys/v2-client";
import type { BusinessDatabase } from "./database";
import type { BusinessRow } from "./rowCodec";
import { readBusinessRows, publicId } from "./products";
import { prepareOwnerCollections } from "./prepareCollections";
import { copyProtectedCollection } from "./copyCollection";
import { projectCollection, projectPayload, type ProjectPayload } from "./projectData";

export async function prepareProjects(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal): Promise<void> {
  const projects = await readBusinessRows(source, "projects"), contacts = new Map<string, BusinessRow[]>();
  for (const row of await readBusinessRows(source, "project_contacts")) {
    const id = row.values.project_id as string, current = contacts.get(id) ?? []; current.push(row); contacts.set(id, current);
  }
  await prepareOwnerCollections(client, subject, projects.map(row => projectCollection(publicId(row.values.id))), signal);
  for (const project of projects) {
    const id = publicId(project.values.id), area = projectCollection(id);
    const payload: ProjectPayload = { format: "sortsys-project-v1", project, contacts: contacts.get(project.values.id as string) ?? [] };
    await copyProtectedCollection(client, area, [{ id: area.prefix, value: payload }], (value, object) => projectPayload(value, object, id), signal);
  }
}

import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { createPrefixMatcher } from "../search/prefixQuery";
import {
  addressId,
  addressText,
  normalizeAddress,
  partialAddressRecord,
  searchableAddressValues,
} from "./addressBook";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";
import type { DataRequest, DataView } from "./runtime/runtime";
import { projectFacetArea, projectFacetDomain } from "./projectScope";

export type Project = QueryResult<"projects.get">;
export type ProjectPayload = {
  format: "sortsys-project-v1";
  project: BusinessRow | null;
  contacts: BusinessRow[];
};
export const PROJECT_MODEL = defineDataModel({
  name: "projects",
  decode(value: unknown, object: string, area: Collection) {
    const id = projectDomainId(area.domain);
    if (!id) throw new InvalidProtectedData();
    return projectPayload(value, object, id);
  },
  externalReferences: ["users", "customers", "contacts"],
});
export const PROJECT_QUERIES = new Set([
  "projects.list",
  "projects.get",
  "projects.contacts.list",
  "contacts.projects.list",
]);
export const PROJECT_COST_QUERIES = new Set([
  "projects.costs.get",
  "projects.costs.overview",
  "projects.costs.filterOptions",
]);

export const PROJECT_EDITS = [
  "projects.update",
  "projects.finish",
  "projects.resume",
  "projects.contacts.add",
  "projects.contacts.set",
  "projects.contacts.remove",
] as const;
export type ProjectEditPath = (typeof PROJECT_EDITS)[number];
export const PROJECT_MUTATIONS = new Set(["projects.create", "projects.delete", ...PROJECT_EDITS]);

export function isProjectEdit(path: string): path is ProjectEditPath {
  return PROJECT_EDITS.some((edit) => edit === path);
}

export function projectCollection(id: string): Collection {
  return { ...projectFacetArea(id, "master-data"), prefix: `project:${id}` };
}

export function projectRequest(id: string): DataRequest<ProjectPayload> {
  return { model: PROJECT_MODEL, area: projectCollection(id) };
}

export function projectDocument(view: DataView, request: DataRequest<ProjectPayload>) {
  const documents = view.documents(request);
  if (documents.length !== 1 || !documents[0]!.value.project)
    throw new InvalidProtectedData();
  return documents[0]!;
}
export function projectDomainId(domain: string): string | null {
  const part = projectFacetDomain(domain);
  return part?.facet === "master-data" ? part.id : null;
}

export function projectPayload(
  input: unknown,
  object: string,
  id: string,
): ProjectPayload {
  const source = record(input, ["format", "project", "contacts"]);
  if (
    object !== projectCollection(id).prefix ||
    source.format !== "sortsys-project-v1" ||
    !Array.isArray(source.contacts) ||
    source.contacts.length > 10000
  )
    throw new InvalidProtectedData();
  if (source.project === null) {
    if (source.contacts.length) throw new InvalidProtectedData();
    return { format: source.format, project: null, contacts: [] };
  }
  const project = decodeBusinessRow(source.project),
    row = project.values;
  if (project.table !== "projects" || publicId(row.id) !== id)
    throw new InvalidProtectedData();
  addressText(row.title, true, 127);
  normalizeAddress(
    row.address === null ? null : JSON.parse(row.address as string),
  );
  for (const key of [
    "customer_id",
    "created_by_user_id",
    "responsible_project_leader_user_id",
  ])
    if (row[key] !== null) addressId(publicId(row[key]));
  const seen = new Set<string>();
  const contacts = source.contacts
    .map((input) => {
      const link = decodeBusinessRow(input);
      if (
        link.table !== "project_contacts" ||
        link.values.project_id !== row.id
      )
        throw new InvalidProtectedData();
      const contact = publicId(link.values.contact_id);
      addressId(contact);
      addressText(link.values.label, false, 127);
      if (seen.has(contact)) throw new InvalidProtectedData();
      seen.add(contact);
      return link;
    })
    .sort((a, b) =>
      (a.values.contact_id as string).localeCompare(
        b.values.contact_id as string,
      ),
    );
  return { format: source.format, project, contacts };
}
const FIELDS = {
  title: "title",
  address: "address",
  customerId: "customer_id",
  responsibleProjectLeaderUserId: "responsible_project_leader_user_id",
  orderReceivedAt: "order_received_at",
};

export function projectCreationInput(input: unknown) {
  const { contacts, ...fields } = partialAddressRecord(input, [
    ...Object.keys(FIELDS),
    "contacts",
  ]);

  return { changes: projectChanges(fields, true), contacts };
}

export function projectChanges(
  input: unknown,
  creating: boolean,
): Record<string, unknown> {
  const source = partialAddressRecord(input, Object.keys(FIELDS)),
    values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(FIELDS)) {
    if (!creating && source[key] === undefined) continue;
    const value = source[key];
    if (key === "title") values[column] = addressText(value, true, 127);
    else if (key === "address")
      values[column] =
        value == null ? null : JSON.stringify(normalizeAddress(value));
    else if (key === "orderReceivedAt") {
      if (value == null) values[column] = null;
      else if (value instanceof Date && Number.isFinite(value.getTime()))
        values[column] = value.toISOString();
      else if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value.slice(0, 10)).toISOString().slice(0, 10) ===
          value.slice(0, 10)
      )
        values[column] = value;
      else throw new InvalidProtectedData();
    } else values[column] = value == null ? null : addressId(value);
  }
  if (!creating && !Object.keys(values).length)
    throw new InvalidProtectedData();
  return values;
}
export function wireProject(payload: ProjectPayload): Project {
  if (!payload.project) throw new InvalidProtectedData();
  const p = payload.project.values;
  return {
    id: publicId(p.id),
    title: p.title as string,
    address: p.address === null ? null : JSON.parse(p.address as string),
    customerId: p.customer_id === null ? null : publicId(p.customer_id),
    createdByUserId:
      p.created_by_user_id === null ? null : publicId(p.created_by_user_id),
    responsibleProjectLeaderUserId:
      p.responsible_project_leader_user_id === null
        ? null
        : publicId(p.responsible_project_leader_user_id),
    orderReceivedAt:
      p.order_received_at === null
        ? null
        : new Date(p.order_received_at as string),
    finishedAt:
      p.finished_at === null ? null : new Date(p.finished_at as string),
    createdAt: new Date(p.created_at as string),
    modifiedAt: new Date(p.modified_at as string),
  };
}
export function createProjectMatcher(search: string | null | undefined) {
  const matches = createPrefixMatcher(search);
  return (value: Project) => matches(projectSearchFields(value));
}
export function projectSearchFields(value: Project) {
  return [value.title, ...searchableAddressValues(value.address)];
}

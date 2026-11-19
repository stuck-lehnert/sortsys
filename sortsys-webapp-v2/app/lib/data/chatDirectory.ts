import type { QueryPath, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { CHAT_SEARCH_QUERIES } from "../liveLlm";
import { CONTACT_COLLECTION, CUSTOMER_COLLECTION } from "./addressBook";
import type { AssistantAccess } from "./assistantStore";
import { PRODUCT_COLLECTION } from "./products";
import { projectCollection, projectDomainId } from "./projectData";
import type { Collection } from "./protectedObjects";
import { VENDOR_COLLECTION } from "./vendorData";

const READS = {
  "customers.list": [CUSTOMER_COLLECTION],
  "customers.get": [CUSTOMER_COLLECTION],
  "contacts.list": [CONTACT_COLLECTION],
  "contacts.get": [CONTACT_COLLECTION],
  "products.vendors.list": [VENDOR_COLLECTION],
  "products.vendors.get": [VENDOR_COLLECTION],
  "customers.contacts.list": [CUSTOMER_COLLECTION, CONTACT_COLLECTION],
  "contacts.customers.list": [CUSTOMER_COLLECTION, CONTACT_COLLECTION],
  "projects.contacts.list": [CONTACT_COLLECTION],
  "contacts.projects.list": [CONTACT_COLLECTION],
} as const satisfies Partial<Record<QueryPath, readonly Collection[]>>;

type DirectoryQuery = keyof typeof READS;
type SearchResource = "customers" | "contacts" | "projects" | "vendors" | "products";
export type AssistantDirectoryPath = (typeof CHAT_SEARCH_QUERIES)[SearchResource];
export type AssistantDirectorySearch = <Path extends AssistantDirectoryPath>(
  path: Path,
  search: string,
  signal: AbortSignal,
  limit: number,
) => Promise<QueryResult<Path> | null>;

function hasProjects(access: AssistantAccess): boolean {
  return access.domains.some(({ id }) => {
    const projectId = projectDomainId(id);
    return projectId !== null && access.canRead(projectCollection(projectId));
  });
}

export function isChatDirectoryQuery(path: string): path is DirectoryQuery {
  return Object.hasOwn(READS, path);
}

function canReadDirectory(path: DirectoryQuery, access: AssistantAccess): boolean {
  if (!READS[path].every((area) => access.canRead(area))) return false;
  if (path === "projects.contacts.list" || path === "contacts.projects.list") {
    return hasProjects(access);
  }
  return true;
}

export function requireChatDirectory(path: DirectoryQuery, access: AssistantAccess) {
  if (!canReadDirectory(path, access)) throw new InvalidProtectedData();
}

export function chatDirectoryPaths(access: AssistantAccess): QueryPath[] {
  return (Object.keys(READS) as DirectoryQuery[]).filter((path) =>
    canReadDirectory(path, access),
  );
}

/** Use the same index and result limit as the other browser directory searches.
 * Compact results omit technical fields such as creators and timestamps. */
export async function searchAssistantDirectory(
  lookup: AssistantDirectorySearch,
  path: AssistantDirectoryPath,
  term: string,
  limit: number,
  signal: AbortSignal,
  access: AssistantAccess,
) {
  if (path === "projects.list") {
    if (!hasProjects(access)) throw new InvalidProtectedData();
    const rows = await lookup(path, term, signal, limit) ?? [];
    return rows
      .filter(({ id }) => access.canRead(projectCollection(id)))
      .map(({ id, title, address, finishedAt }) => ({ id, title, address, finishedAt }));
  }
  if (path === "products.list") {
    if (!access.canRead(PRODUCT_COLLECTION)) throw new InvalidProtectedData();
    return await lookup(path, term, signal, limit) ?? [];
  }

  requireChatDirectory(path, access);
  switch (path) {
    case "customers.list": {
      const rows = await lookup(path, term, signal, limit) ?? [];
      return rows.map(({ id, name, address }) => ({ id, name, address }));
    }
    case "contacts.list": {
      const rows = await lookup(path, term, signal, limit) ?? [];
      return rows.map(({ id, firstName, lastName, phoneNumbers, emailAddresses }) => ({
        id,
        firstName,
        lastName,
        phoneNumbers,
        emailAddresses,
      }));
    }
    case "products.vendors.list": {
      const rows = await lookup(path, term, signal, limit) ?? [];
      return rows.map(({ id, name, description }) => ({ id, name, description }));
    }
  }
}

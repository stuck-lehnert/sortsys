import type { QueryPath, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { readAssistantAccess } from "./assistantStore";
import {
  projectAccessArea,
  projectAccessDomain,
  type ProjectAccessKey,
} from "./projectScope";

const READS = {
  "master-data": ["projects.list", "projects.get"],
  "daily-reports:master-data": [
    "projects.dailyReports.list",
    "projects.dailyReports.get",
  ],
  "regie-reports:master-data": ["regieReports.list", "regieReports.get"],
  "delivery-notes:master-data": ["deliveryNotes.list", "deliveryNotes.get"],
} as const satisfies Partial<Record<ProjectAccessKey, readonly QueryPath[]>>;

type Section = keyof typeof READS;
type Access = Awaited<ReturnType<typeof readAssistantAccess>>;

function section(key: string): key is Section {
  return Object.hasOwn(READS, key);
}

function allowedAreas(access: Access) {
  const allowed = new Map<string, ProjectAccessKey>();
  for (const domain of access.domains) {
    const resource = projectAccessDomain(domain.id);
    if (!resource) continue;
    const area = projectAccessArea(resource.id, resource.key);
    if (domain.scope !== area.scope || domain.facet !== area.facet) {
      throw new InvalidProtectedData();
    }
    if (access.allows(area.scope, area.facet, "read")) {
      allowed.set(domain.id, resource.key);
    }
  }
  return allowed;
}

export function projectChatPaths(access: Access): QueryPath[] {
  const queries = new Set<QueryPath>();
  for (const key of allowedAreas(access).values()) {
    if (section(key)) {
      for (const path of READS[key]) queries.add(path);
    }
  }
  return [...queries];
}

export function projectChatSection(path: string): Section | undefined {
  for (const key of Object.keys(READS)) {
    if (section(key) && READS[key].some((choice) => choice === path)) return key;
  }
}

/** Project files have their own explicit consent. Strip photo metadata even
 * if the report adapter could resolve it for a signed-in file reader. Recheck
 * every result against the current inventory, including separately held costs
 * and personnel data. */
export function visibleProjectChatResult(
  key: Section,
  result: unknown,
  access: Access,
): unknown {
  const allowed = allowedAreas(access);
  const mayRead = (id: string, facet: ProjectAccessKey) =>
    allowed.has(projectAccessArea(id, facet).domain);

  function visible(input: unknown) {
    if (!input || typeof input !== "object") throw new InvalidProtectedData();
    const row = input as Record<string, unknown>;
    const projectId = key === "master-data" ? row.id : row.projectId;
    if (typeof projectId !== "string") throw new InvalidProtectedData();
    if (!mayRead(projectId, key)) return null;

    if (key === "daily-reports:master-data") {
      const report = input as QueryResult<"projects.dailyReports.get">;
      if (mayRead(projectId, "daily-reports:calculation")) {
        return { ...report, photos: [] };
      }
      const { costRevision, ...withoutCosts } = report;
      return {
        ...withoutCosts,
        photos: [],
        workHours: report.workHours.map((entry) => ({
          ...entry,
          costPerHour: null,
        })),
      };
    }
    if (
      key === "regie-reports:master-data" &&
      !mayRead(projectId, "regie-reports:personnel")
    ) {
      const { hoursRevision, ...report } =
        input as QueryResult<"regieReports.get">;
      return { ...report, workHoursAvailable: false, workHours: [] };
    }
    if (
      key === "delivery-notes:master-data" &&
      !mayRead(projectId, "delivery-notes:procurement")
    ) {
      const { priceRevision, ...note } = input as QueryResult<"deliveryNotes.get">;
      return {
        ...note,
        specialRecords: note.specialRecords.map((entry) => ({
          ...entry,
          pricePerUnit: null,
        })),
      };
    }
    return input;
  }

  if (Array.isArray(result)) {
    return result.map(visible).filter((row) => row !== null);
  }
  const row = visible(result);
  if (!row) throw new InvalidProtectedData();
  return row;
}

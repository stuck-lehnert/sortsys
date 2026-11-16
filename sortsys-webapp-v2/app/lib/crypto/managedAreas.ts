import {
  absenceDomain,
  compilePolicy,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import { MASTER_DATA_AREAS, MASTER_DATA_FIELDS } from "./accessProfiles";
import { ORGANIZATION_AREAS } from "../data/organizationData";
import {
  commercialCollection,
  commercialDomain,
} from "../data/commercialAreas";
import { personnelCollection, personnelDomain } from "../data/personnelData";
import { projectAccessArea, projectAccessDomain } from "../data/projectScope";
import { toolCollection, toolDomain, TOOL_INDEX } from "../data/toolData";
import { absenceCollection } from "../data/absenceData";
import type { Collection } from "../data/protectedObjects";

export type ManagedArea = {
  area: Collection;
  kind:
    | "catalogue"
    | "organization"
    | "project"
    | "commercial"
    | "personnel"
    | "tool"
    | "tool-tracking"
    | "absence";
  resourceId?: string;
  key: string;
};

export function hasScopedManagement(
  permissions: Policy,
  subject: string,
): boolean {
  const access = compilePolicy(permissions, [subject]);
  return access.areas.some(
    ({ scope, facet, actions }) =>
      actions.includes("grant") &&
      actions.includes("read") &&
      managedArea(`${scope}:${facet}`) !== null,
  );
}

/** Recognize business areas through their owning models. Personal preferences,
 * chat histories and creation capabilities are deliberately separate. */
export function managedArea(domain: string): ManagedArea | null {
  for (const key of MASTER_DATA_FIELDS) {
    const area = MASTER_DATA_AREAS[key];
    if (area.domain === domain) return { area, kind: "catalogue", key };
  }
  const organization = ORGANIZATION_AREAS.find(
    (area) => area.domain === domain,
  );
  if (organization)
    return { area: organization, kind: "organization", key: domain };
  if (domain === TOOL_INDEX.domain)
    return { area: TOOL_INDEX, kind: "catalogue", key: "tools" };
  const project = projectAccessDomain(domain);
  if (project)
    return {
      area: projectAccessArea(project.id, project.key),
      kind: "project",
      resourceId: project.id,
      key: project.key,
    };
  const commercial = commercialDomain(domain);
  if (commercial)
    return {
      area: commercialCollection(commercial.id, commercial.facet),
      kind: "commercial",
      resourceId: commercial.id,
      key: commercial.facet,
    };
  const person = personnelDomain(domain);
  if (person)
    return {
      area: personnelCollection(person.id, person.facet),
      kind: "personnel",
      resourceId: person.id,
      key: person.facet,
    };
  const tool = toolDomain(domain);
  if (tool)
    return {
      area: toolCollection(tool.namespace, tool.id, tool.facet),
      kind: tool.namespace,
      resourceId: tool.id,
      key: tool.facet,
    };
  const absence = absenceDomain(domain);
  if (absence)
    return {
      area: absenceCollection(absence.user, absence.facet === "personnel"),
      kind: "absence",
      resourceId: absence.user,
      key: absence.facet,
    };
  return null;
}

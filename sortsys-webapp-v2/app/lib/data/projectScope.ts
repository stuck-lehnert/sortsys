import {
  CREATION_FACETS,
  creationResource,
  InvalidProtectedData,
  PROJECT_MODULE_FACETS,
  type Facet,
  type ProjectModule,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import type { Collection } from "./protectedObjects";

export const PROJECT_FACETS = CREATION_FACETS.project;
export type ProjectFacet = (typeof PROJECT_FACETS)[number];
export type ProjectModuleFacet<M extends ProjectModule> =
  (typeof PROJECT_MODULE_FACETS)[M][number];
export type ProjectAccessKey =
  | ProjectFacet
  | { [M in ProjectModule]: `${M}:${ProjectModuleFacet<M>}` }[ProjectModule];
export const PROJECT_ACCESS_KEYS: readonly ProjectAccessKey[] = [
  ...PROJECT_FACETS,
  ...Object.entries(PROJECT_MODULE_FACETS).flatMap(([module, facets]) =>
    facets.map((facet) => `${module}:${facet}` as ProjectAccessKey),
  ),
];

/** One facet inventory for creation, policy editing and domain recognition.
 * Object prefixes remain owned by the individual business models. */
export function projectFacetArea(id: string, facet: ProjectFacet): Collection {
  addressId(id);
  if (!(PROJECT_FACETS as readonly string[]).includes(facet))
    throw new InvalidProtectedData();
  const scope = `project:${id}`;
  return { domain: `${scope}:${facet}`, scope, facet, prefix: "" };
}
export function projectFacetDomain(
  domain: string,
): { id: string; facet: ProjectFacet } | null {
  const match = /^project:([1-9a-v][0-9a-v]{0,12}):([a-z-]+)$/.exec(domain);
  if (!match || !(PROJECT_FACETS as readonly string[]).includes(match[2]!))
    return null;
  addressId(match[1]);
  return { id: match[1]!, facet: match[2] as ProjectFacet };
}

export function projectModuleArea<M extends ProjectModule>(
  id: string,
  module: M,
  facet: ProjectModuleFacet<M>,
): Collection {
  addressId(id);
  if (
    !Object.hasOwn(PROJECT_MODULE_FACETS, module) ||
    !(PROJECT_MODULE_FACETS[module] as readonly Facet[]).includes(facet)
  )
    throw new InvalidProtectedData();
  const scope = `project:${id}:${module}`;
  return { domain: `${scope}:${facet}`, scope, facet, prefix: "" };
}
export function projectModuleDomain(
  domain: string,
): { id: string; module: ProjectModule; facet: Facet } | null {
  const index = domain.lastIndexOf(":"),
    scope = domain.slice(0, index),
    facet = domain.slice(index + 1) as Facet;
  const resource = creationResource(scope);
  if (
    !resource?.module ||
    !(PROJECT_MODULE_FACETS[resource.module] as readonly Facet[]).includes(
      facet,
    )
  )
    return null;
  return { id: resource.id, module: resource.module, facet };
}

/** Verify the collection binding before handing its project to a row codec. */
export function projectModuleDecoder<T>(
  collection: (projectId: string) => Collection,
  decode: (value: unknown, object: string, projectId: string) => T,
) {
  return (value: unknown, object: string, area: Collection): T => {
    const part = projectModuleDomain(area.domain);
    if (!part) throw new InvalidProtectedData();

    const expected = collection(part.id);
    if (
      area.domain !== expected.domain ||
      area.scope !== expected.scope ||
      area.facet !== expected.facet ||
      area.prefix !== expected.prefix
    ) {
      throw new InvalidProtectedData();
    }

    return decode(value, object, part.id);
  };
}

export function projectAccessArea(
  id: string,
  key: ProjectAccessKey,
): Collection {
  if (!PROJECT_ACCESS_KEYS.includes(key)) throw new InvalidProtectedData();
  const [module, facet] = key.split(":");
  return facet
    ? projectModuleArea(
        id,
        module as ProjectModule,
        facet as ProjectModuleFacet<ProjectModule>,
      )
    : projectFacetArea(id, key as ProjectFacet);
}
export function projectAccessDomain(
  domain: string,
): { id: string; key: ProjectAccessKey } | null {
  const root = projectFacetDomain(domain);
  if (root) return { id: root.id, key: root.facet };
  const part = projectModuleDomain(domain);
  return part
    ? { id: part.id, key: `${part.module}:${part.facet}` as ProjectAccessKey }
    : null;
}

import {
  CREATION_FACETS,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import type { Collection } from "./protectedObjects";

export const COMMERCIAL_FACETS = CREATION_FACETS.commercial;
export type CommercialFacet = (typeof COMMERCIAL_FACETS)[number];

/** Offers exist before a project. Linking a case to a project must never
 * silently turn its master-data grant into a price or calculation grant. */
export function commercialCollection(
  id: string,
  facet: CommercialFacet,
): Collection {
  addressId(id);
  if (!(COMMERCIAL_FACETS as readonly string[]).includes(facet))
    throw new InvalidProtectedData();
  const scope = `commercial:${id}`;
  return {
    domain: `${scope}:${facet}`,
    scope,
    facet,
    prefix: `${scope}:${facet}:`,
  };
}
export function commercialDomain(
  domain: string,
): { id: string; facet: CommercialFacet } | null {
  const match = /^commercial:([1-9a-v][0-9a-v]{0,12}):([a-z-]+)$/.exec(domain);
  if (!match || !(COMMERCIAL_FACETS as readonly string[]).includes(match[2]))
    return null;
  addressId(match[1]);
  return { id: match[1], facet: match[2] as CommercialFacet };
}

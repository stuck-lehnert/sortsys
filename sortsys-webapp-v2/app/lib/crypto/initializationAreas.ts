import { CUSTOMER_COLLECTION, CONTACT_COLLECTION } from "../data/addressBook";
import { absenceCollection } from "../data/absenceData";
import { ORGANIZATION_AREAS } from "../data/organizationData";
import { PERSONNEL_FACETS, personnelCollection } from "../data/personnelData";
import { gaebViewCollection } from "../data/preferenceData";
import { historyCollection } from "../data/personalHistoryData";
import { PRODUCT_COLLECTION, PRICE_COLLECTION } from "../data/products";
import { privateLlmCollection } from "../data/privateLlm";
import type { Collection } from "../data/protectedObjects";
import { TOOL_INDEX } from "../data/toolData";
import { VENDOR_COLLECTION } from "../data/vendorData";

export function initialOwnerCollections(userId: string): Collection[] {
  const subject = `user:${userId}`;
  const areas = [
    ...ORGANIZATION_AREAS,
    CUSTOMER_COLLECTION,
    CONTACT_COLLECTION,
    PRODUCT_COLLECTION,
    PRICE_COLLECTION,
    VENDOR_COLLECTION,
    TOOL_INDEX,
    ...PERSONNEL_FACETS.map((facet) => personnelCollection(userId, facet)),
    absenceCollection(userId),
    absenceCollection(userId, true),
    gaebViewCollection(subject),
    historyCollection(subject),
    privateLlmCollection(subject),
  ];
  return [...new Map(areas.map((area) => [area.domain, area])).values()];
}

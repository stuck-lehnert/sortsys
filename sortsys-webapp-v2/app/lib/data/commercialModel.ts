import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { addressId } from "./addressBook";
import { commercialCollection, commercialDomain, type CommercialFacet } from "./commercialAreas";
import { commercialFacetPayload, COMMERCIAL_STATUSES, COMMERCIAL_TABLES, type CommercialPayload } from "./commercialData";
import type { WorkflowReceipt } from "./commercialWorkflow";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";
import type { DataRequest } from "./runtime/runtime";

/** Header and receipt namespaces are disjoint from immutable XML fragments.
 * A list therefore never loads document contents or treats private fields as NULL. */
export const COMMERCIAL_MODEL = defineDataModel<CommercialPayload>({
  name: "commercial-case",
  decode(value, object, area) {
    const part = commercialDomain(area.domain);
    if (!part || area.scope !== `commercial:${part.id}` || area.facet !== part.facet || object !== `${commercialCollection(part.id, part.facet).prefix}case`) throw new InvalidProtectedData();
    return commercialFacetPayload(value, part.id, part.facet);
  },
  sources: payload => payload.rows.map((row, index) => ({
    ...row,
    kind: payload.facet === "master-data" || ["commercial_invoice_details", "commercial_invoice_payments"].includes(row.table) ? "entity" : "fragment",
    fields: Object.fromEntries(Object.keys(row.values).filter(column => !["id", "case_id"].includes(column)).map(column => [column, { path: ["rows", index, "values", column] }])),
  })),
  tables: area => area.facet === "master-data" ? ["commercial_cases", "commercial_documents", "commercial_case_events"] : area.facet === "billing" ? COMMERCIAL_TABLES.filter(table => table !== "commercial_case_events")
    : area.facet === "attachment" ? ["commercial_documents"] : area.facet === "scope" ? ["commercial_cases"]
      : ["offer-prices", "calculation", "procurement"].includes(area.facet) ? ["commercial_cases", "commercial_documents"] : [],
  externalReferences: ["users", "customers", "projects", "commercial_cases", "commercial_documents"],
});

export function commercialRequest(id: string, facet: CommercialFacet): DataRequest<CommercialPayload> {
  const area = commercialCollection(id, facet);
  return { model: COMMERCIAL_MODEL, area: { ...area, prefix: `${area.prefix}case` } };
}

export const WORKFLOW_RECEIPT_MODEL = defineDataModel<WorkflowReceipt>({
  name: "commercial-workflow-receipt",
  decode(input, object, area) {
    const part = commercialDomain(area.domain), value = record(input, ["format", "caseId", "eventId", "status", "previousStatus", "createdAt", "documents"]);
    if (!part || part.facet !== "master-data" || area.scope !== `commercial:${part.id}` || area.facet !== part.facet
      || value.format !== "sortsys-workflow-receipt-v1" || value.caseId !== part.id || typeof value.eventId !== "string"
      || object !== `${commercialCollection(part.id, part.facet).prefix}receipt:${value.eventId}`
      || !COMMERCIAL_STATUSES.includes(value.status as typeof COMMERCIAL_STATUSES[number])
      || value.previousStatus !== null && !COMMERCIAL_STATUSES.includes(value.previousStatus as typeof COMMERCIAL_STATUSES[number])
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.documents) || value.documents.length > 10000) throw new InvalidProtectedData();
    addressId(value.eventId);
    const ids = new Set<string>();
    for (const input of value.documents) {
      const document = record(input, ["id", "version", "hash"]); addressId(document.id);
      if (ids.has(document.id as string) || typeof document.version !== "string" || !/^[1-9]\d*$/.test(document.version) || typeof document.hash !== "string" || !document.hash.length) throw new InvalidProtectedData();
      ids.add(document.id as string);
    }
    return value as WorkflowReceipt;
  },
  sources: () => [],
  tables: [],
});

export function workflowReceiptRequest(id: string, ids: string[]): DataRequest<WorkflowReceipt> {
  const area: Collection = commercialCollection(id, "master-data");
  return { model: WORKFLOW_RECEIPT_MODEL, area: { ...area, prefix: `${area.prefix}receipt:` }, ids };
}

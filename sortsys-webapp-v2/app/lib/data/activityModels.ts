import {
  absenceDomain,
  InvalidProtectedData,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import {
  CONTACT_COLLECTION,
  CONTACT_MODEL,
  CUSTOMER_COLLECTION,
  CUSTOMER_MODEL,
} from "./addressBook";
import {
  PRODUCT_COLLECTION,
  PRODUCT_MODEL,
  PRICE_COLLECTION,
  PRICE_MODEL,
} from "./products";
import { VENDOR_COLLECTION, VENDOR_MODEL } from "./vendorData";
import {
  personnelCollection,
  personnelDomain,
  PERSONNEL_MODEL,
} from "./personnelData";
import {
  projectCollection,
  projectDomainId,
  PROJECT_MODEL,
} from "./projectData";
import {
  dailyCollection,
  dailyDomain,
  DAILY_MODEL,
  DAILY_COST_MODEL,
} from "./dailyReportData";
import {
  regieCollection,
  regieDomain,
  REGIE_MODEL,
  REGIE_HOUR_MODEL,
} from "./regieReportData";
import {
  deliveryCollection,
  deliveryDomain,
  DELIVERY_MODEL,
  DELIVERY_PRICE_MODEL,
} from "./deliveryNoteData";
import {
  scheduleCollection,
  scheduleDomain,
  SCHEDULE_MODEL,
} from "./projectScheduleData";
import {
  fileCollection,
  fileDomainId,
  filePayload,
  folderPayload,
} from "./projectFileData";
import { toolCollection, toolDomain, TOOL_MODEL } from "./toolData";
import {
  absenceCollection,
  ABSENCE_REQUEST_MODEL,
  ABSENCE_DECISION_MODEL,
  verifyLegacyAbsence,
  type AbsenceRequest,
  type AbsenceDecision,
} from "./absenceData";
import {
  defineDataModel,
  openDataDocument,
  type DataModel,
  type RowSource,
} from "./runtime/model";
import type { Collection, OpenedObject } from "./protectedObjects";
import { addressId } from "./addressBook";
import { decodeBusinessFields } from "./rowCodec";
import {
  financialCollection,
  financialDomain,
  FINANCIAL_MODEL,
} from "./projectFinancialData";

/** Canonical source decoders are shared with the editing adapters. A valid
 * signature alone must not turn an arbitrary JSON row into a history event. */
export const ACTIVITY_PREFIXES = [
  "product:",
  "product-price:",
  "vendor:",
  "customer:",
  "contact:",
  "personnel:",
  "project:",
  "financial:",
  "immutable:project:",
  "project-files:",
  "tool:",
  "tool-tracking:",
  "daily-report:",
  "daily-costs:",
  "regie-report:",
  "regie-hours:",
  "delivery-note:",
  "delivery-price:",
  "schedule:",
  "absence:",
  "legacy-activity:",
];
export function activityArea(
  domain: string,
  object?: string,
): Collection | null {
  const area = sourceArea(domain, object);
  if (area && object !== undefined && !object.startsWith(area.prefix))
    return null;
  return area;
}
function sourceArea(domain: string, object?: string): Collection | null {
  for (const area of [
    PRODUCT_COLLECTION,
    PRICE_COLLECTION,
    VENDOR_COLLECTION,
    CUSTOMER_COLLECTION,
    CONTACT_COLLECTION,
  ])
    if (area.domain === domain) return area;
  const person = personnelDomain(domain);
  if (person) return personnelCollection(person.id, person.facet);
  const project = projectDomainId(domain);
  if (project) return projectCollection(project);
  const financial = financialDomain(domain);
  if (financial && object) {
    const candidates = [
      financialCollection(financial.projectId, financial.type),
    ];
    if (financial.type === "invoice")
      candidates.push(
        financialCollection(financial.projectId, financial.type, true),
      );
    const area = candidates.find((area) => object.startsWith(area.prefix));
    if (area) return area;
  }
  const file = fileDomainId(domain);
  if (file) return fileCollection(file);
  const daily = dailyDomain(domain);
  if (daily) return dailyCollection(daily.projectId, daily.costs);
  const regie = regieDomain(domain);
  if (regie) return regieCollection(regie.projectId, regie.hours);
  const delivery = deliveryDomain(domain);
  if (delivery) return deliveryCollection(delivery.projectId, delivery.prices);
  const schedule = scheduleDomain(domain);
  if (schedule) return scheduleCollection(schedule);
  const tool = toolDomain(domain);
  if (tool) return toolCollection(tool.namespace, tool.id, tool.facet);
  const absence = absenceDomain(domain);
  if (absence)
    return absenceCollection(absence.user, absence.facet === "personnel");
  return null;
}
const FILE_MODEL = defineDataModel({
  name: "file-history",
  decode(input: unknown, object: string, area: Collection) {
    const id = fileDomainId(area.domain);
    if (!id) throw new InvalidProtectedData();
    return object.startsWith(area.prefix + "file:")
      ? filePayload(input, object, id)
      : folderPayload(input, object, id);
  },
});
export function activityModel(area: Collection): DataModel<unknown> {
  if (area.domain === PRODUCT_COLLECTION.domain) return PRODUCT_MODEL;
  if (area.domain === PRICE_COLLECTION.domain) return PRICE_MODEL;
  if (area.domain === VENDOR_COLLECTION.domain) return VENDOR_MODEL;
  if (area.domain === CUSTOMER_COLLECTION.domain) return CUSTOMER_MODEL;
  if (area.domain === CONTACT_COLLECTION.domain) return CONTACT_MODEL;
  if (personnelDomain(area.domain)) return PERSONNEL_MODEL;
  if (projectDomainId(area.domain)) return PROJECT_MODEL;
  if (financialDomain(area.domain)) return FINANCIAL_MODEL;
  if (fileDomainId(area.domain)) return FILE_MODEL;
  const daily = dailyDomain(area.domain);
  if (daily) return daily.costs ? DAILY_COST_MODEL : DAILY_MODEL;
  const regie = regieDomain(area.domain);
  if (regie) return regie.hours ? REGIE_HOUR_MODEL : REGIE_MODEL;
  const delivery = deliveryDomain(area.domain);
  if (delivery) return delivery.prices ? DELIVERY_PRICE_MODEL : DELIVERY_MODEL;
  if (scheduleDomain(area.domain)) return SCHEDULE_MODEL;
  if (toolDomain(area.domain)) return TOOL_MODEL;
  const absence = absenceDomain(area.domain);
  if (absence)
    return absence.facet === "personnel"
      ? ABSENCE_DECISION_MODEL
      : ABSENCE_REQUEST_MODEL;
  throw new InvalidProtectedData();
}
export async function activitySources(
  area: Collection,
  object: OpenedObject,
  tenant: string,
  authority: (generation: string) => CryptoKey,
): Promise<readonly RowSource[]> {
  if (object.envelope.format === TOMBSTONE_FORMAT) return [];
  const document = openDataDocument(activityModel(area), area, object, true);
  if (!absenceDomain(area.domain)) return document.sources;
  const value = document.value as AbsenceRequest | AbsenceDecision;
  await verifyLegacyAbsence(value, tenant, authority);
  const fields =
    value.format === "sortsys-absence-request-v1"
      ? value.row.values
      : {
          id: addressId(value.id),
          user_id: addressId(value.userId),
          status: value.status,
          denial_reason: value.denialReason,
          decided_by_user_id:
            value.decidedByUserId === null
              ? null
              : addressId(value.decidedByUserId),
          decided_at: value.decidedAt,
          modified_at: value.modifiedAt,
        };
  return [
    {
      ...decodeBusinessFields("user_vacations", fields),
      kind:
        value.format === "sortsys-absence-request-v1" ? "entity" : "fragment",
      fields: {},
    },
  ];
}

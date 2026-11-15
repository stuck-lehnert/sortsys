import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { COMMERCIAL_STATUSES, type CommercialCase } from "./commercialData";

export function validCommercialTransition(
  kind: string,
  from: string,
  to: string,
): boolean {
  const pairs = ["offer", "variation", "alternative"].includes(kind)
    ? [
        "draft:sent",
        "sent:draft",
        "sent:accepted",
        "sent:rejected",
        "draft:cancelled",
        "sent:cancelled",
      ]
    : ["subcontract", "procurement"].includes(kind)
      ? [
          "draft:requested",
          "requested:awarded",
          "awarded:confirmed",
          "draft:cancelled",
          "requested:cancelled",
        ]
      : kind === "measurement"
        ? [
            "draft:submitted",
            "submitted:draft",
            "submitted:approved",
            "draft:cancelled",
          ]
        : kind === "calculation"
          ? ["draft:approved", "draft:cancelled"]
          : ["invoice", "progress_invoice", "final_invoice"].includes(kind)
            ? ["draft:cancelled"]
            : [];
  return pairs.includes(`${from}:${to}`);
}
export function transitionPurpose(kind: string, to: string): string | null {
  if (["sent", "accepted"].includes(to))
    return kind === "alternative" ? "alternative" : "offer";
  if (to === "requested")
    return kind === "procurement" ? "price_inquiry" : "inquiry";
  if (to === "awarded")
    return kind === "procurement" ? "purchase_order" : "order";
  if (to === "confirmed")
    return kind === "procurement" ? "supplier_confirmation" : "confirmation";
  if (["submitted", "approved"].includes(to))
    return kind === "calculation" ? "calculation" : "measurement";
  return null;
}
export function transitionInput(input: unknown) {
  const p = partialAddressRecord(input, [
    "id",
    "expectedStatus",
    "status",
    "selectedOfferDocumentId",
    "awardedItemIds",
  ]);
  addressId(p.id);
  if (
    ![p.expectedStatus, p.status].every(
      (value) =>
        typeof value === "string" &&
        (COMMERCIAL_STATUSES as readonly string[]).includes(value),
    ) ||
    (p.status !== "awarded" &&
      (p.selectedOfferDocumentId != null || p.awardedItemIds != null))
  )
    throw new InvalidProtectedData();
  if (p.selectedOfferDocumentId != null) addressId(p.selectedOfferDocumentId);
  if (
    p.awardedItemIds != null &&
    (!Array.isArray(p.awardedItemIds) ||
      p.awardedItemIds.length > 20000 ||
      p.awardedItemIds.some(
        (id) => typeof id !== "string" || !id.length || id.length > 200,
      ) ||
      new Set(p.awardedItemIds).size !== p.awardedItemIds.length)
  )
    throw new InvalidProtectedData();
  return p as {
    id: string;
    expectedStatus: string;
    status: CommercialCase["status"];
    selectedOfferDocumentId?: string | null;
    awardedItemIds?: string[] | null;
  };
}
export type WorkflowReceipt = {
  format: "sortsys-workflow-receipt-v1";
  caseId: string;
  eventId: string;
  status: string;
  previousStatus: string | null;
  createdAt: string;
  documents: { id: string; version: string; hash: string }[];
};

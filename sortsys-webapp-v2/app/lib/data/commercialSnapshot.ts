import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { PreparedWrites } from "./atomicWrites";
import { commercialDomain, type CommercialFacet } from "./commercialAreas";
import {
  commercialCents,
  joinCommercialFacets,
  wireCommercialInvoice,
  type CommercialPayload,
} from "./commercialData";
import {
  invoiceViewRequest,
  ISSUED_STATUSES,
  type InvoiceSeal,
} from "./commercialBillingData";
import type { BusinessRow } from "./rowCodec";
import type { DataRequest, DataView } from "./runtime/runtime";

export type CasePart = {
  request: DataRequest<CommercialPayload>;
  head: PreparedWrites["head"];
  signature?: string;
  value?: CommercialPayload;
  canUpdate: boolean;
};
export type CaseSnapshot = {
  id: string;
  values: BusinessRow[];
  parts: Map<CommercialFacet, CasePart>;
  visible: ReadonlySet<string>;
  seal: InvoiceSeal | null;
  retainedDocuments?: ReadonlySet<string>;
};
export const caseGuards = (snapshot: CaseSnapshot) =>
  [...snapshot.parts.values()].map((part) => part.head);
export const hasCaseFacet = (snapshot: CaseSnapshot, facet: CommercialFacet) =>
  snapshot.parts.has(facet);

export function invoiceViewRequests(
  selected: readonly DataRequest<CommercialPayload>[],
) {
  return selected.flatMap((request) => {
    const binding = commercialDomain(request.area.domain)!;
    if (binding.facet !== "master-data" && binding.facet !== "billing")
      return [];
    return [invoiceViewRequest(binding.id, binding.facet)];
  });
}

/** The issued parts are authoritative even if a raw writer changes a mutable
 * case fragment. Payment records remain separately append-only. Readers only
 * open the facets already included in their current permissions. */
export function issuedCaseSnapshot(
  view: DataView,
  snapshot: CaseSnapshot,
): CaseSnapshot {
  const master = view.documents(invoiceViewRequest(snapshot.id, "master-data"));
  const sealDocument = master.find(
    (document) => document.value.format === "sortsys-invoice-seal-v1",
  );
  const hasBilling = snapshot.parts.has("billing");
  const billing = hasBilling
    ? view.documents(invoiceViewRequest(snapshot.id, "billing"))
    : [];
  if (!sealDocument) {
    if (billing.length) throw new InvalidProtectedData();
    return snapshot;
  }
  const seal = sealDocument.value;
  if (seal.format !== "sortsys-invoice-seal-v1" || master.length !== 1)
    throw new InvalidProtectedData();
  const facets = new Map(
    [...snapshot.parts]
      .filter(([, part]) => part.value)
      .map(([facet, part]) => [facet, part.value!]),
  );
  facets.set("master-data", seal.master);
  if (hasBilling) {
    const sealedBilling = billing.filter(
      (document) => document.value.format === "sortsys-commercial-case-v1",
    );
    if (
      sealedBilling.length !== 1 ||
      sealedBilling[0]!.signature !== seal.billingSignature
    )
      throw new InvalidProtectedData();
    const value = sealedBilling[0]!.value;
    if (value.format !== "sortsys-commercial-case-v1")
      throw new InvalidProtectedData();
    facets.set("billing", value);
  }
  const values = joinCommercialFacets(snapshot.id, facets);
  const main = values.find((row) => row.table === "commercial_cases")!;
  const mutableMain = snapshot.values.find(
    (row) => row.table === "commercial_cases",
  )?.values;
  if (hasBilling) {
    const ids = new Set(
      values
        .filter((row) => row.table === "commercial_invoice_payments")
        .map((row) => row.values.id),
    );
    for (const document of billing) {
      const value = document.value;
      if (value.format !== "sortsys-invoice-payment-v1") continue;
      if (ids.has(value.payment.values.id)) throw new InvalidProtectedData();
      ids.add(value.payment.values.id);
      values.push(value.payment, value.event);
    }
    const invoice = wireCommercialInvoice(values);
    if (!invoice) throw new InvalidProtectedData();
    const paid = commercialCents(invoice.paidAmount);
    const gross = commercialCents(invoice.grossAmount);
    if (paid > gross) throw new InvalidProtectedData();
    if (paid === 0n) main.values.status = "sent";
    else if (paid === gross) main.values.status = "paid";
    else main.values.status = "partially_paid";
  } else if (
    mutableMain &&
    ISSUED_STATUSES.includes(mutableMain.status as string)
  ) {
    // Payment status is visible metadata; financial readers verify it against
    // the immutable amounts. It never determines whether editing is allowed.
    main.values.status = mutableMain.status;
    const oldIds = new Set(
      values
        .filter((row) => row.table === "commercial_case_events")
        .map((row) => row.values.id),
    );
    values.push(
      ...snapshot.values.filter(
        (row) =>
          row.table === "commercial_case_events" && !oldIds.has(row.values.id),
      ),
    );
  }
  return { ...snapshot, values, seal };
}

import type { QueryResult } from "@sortsys/v2-client";
import {
  immutableObject,
  immutablePrefix,
  InvalidProtectedData,
  record,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { calendarDay } from "./calendarDays";
import { commercialCollection, commercialDomain } from "./commercialAreas";
import {
  commercialCents,
  commercialMoney,
  commercialFacetPayload,
  isInvoice,
  type CommercialPayload,
  type InvoiceKind,
} from "./commercialData";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";
import type { Collection } from "./protectedObjects";

export type { InvoiceKind } from "./commercialData";
export type InvoiceStatus =
  | "draft"
  | "cancelled"
  | "sent"
  | "partially_paid"
  | "paid";
export type BillingEntry = {
  id: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  invoiceNumber: string | null;
  invoiceDate: string;
  netAmount: string;
  grossAmount: string;
  paidAmount: string;
  vatRate: string;
};
export type BillingRegister = {
  format: "sortsys-contract-billing-v1";
  contractCaseId: string;
  invoices: BillingEntry[];
};
export type InvoiceSeal = {
  format: "sortsys-invoice-seal-v1";
  caseId: string;
  master: CommercialPayload;
  billingSignature: string;
  document: { id: string; version: string; hash: string };
  numberClaim: { object: string; signature: string };
};
export type InvoicePayment = {
  format: "sortsys-invoice-payment-v1";
  caseId: string;
  payment: BusinessRow;
  event: BusinessRow;
};
export const ISSUED_STATUSES: readonly string[] = [
  "sent",
  "partially_paid",
  "paid",
];
const INVOICE_STATUSES = ["draft", "cancelled", ...ISSUED_STATUSES];

export function billingMoney(input: unknown): string {
  const value = commercialCents(input);
  if (value < 0n || value > 99_999_999_999_999n)
    throw new InvalidProtectedData();
  return commercialMoney(value);
}

export function billingRate(input: unknown): string {
  const value = billingMoney(input);
  if (commercialCents(value) > 10_000n) throw new InvalidProtectedData();
  return value;
}

export function billingEntry(input: unknown): BillingEntry {
  const value = record(input, [
    "id",
    "kind",
    "status",
    "invoiceNumber",
    "invoiceDate",
    "netAmount",
    "grossAmount",
    "paidAmount",
    "vatRate",
  ]);
  addressId(value.id);
  if (
    !isInvoice(value.kind as string) ||
    !INVOICE_STATUSES.includes(value.status as string)
  )
    throw new InvalidProtectedData();
  if (
    value.invoiceNumber !== null &&
    (typeof value.invoiceNumber !== "string" ||
      !value.invoiceNumber ||
      value.invoiceNumber.length > 255 ||
      value.invoiceNumber.includes("\0"))
  )
    throw new InvalidProtectedData();
  if (
    ISSUED_STATUSES.includes(value.status as string) &&
    value.invoiceNumber === null
  )
    throw new InvalidProtectedData();
  const grossAmount = billingMoney(value.grossAmount);
  const paidAmount = billingMoney(value.paidAmount);
  if (commercialCents(paidAmount) > commercialCents(grossAmount))
    throw new InvalidProtectedData();
  return {
    id: value.id as string,
    kind: value.kind as InvoiceKind,
    status: value.status as InvoiceStatus,
    invoiceNumber: value.invoiceNumber as string | null,
    invoiceDate: calendarDay(value.invoiceDate),
    netAmount: billingMoney(value.netAmount),
    grossAmount,
    paidAmount,
    vatRate: billingRate(value.vatRate),
  };
}

export function billingCollection(contractCaseId: string): Collection {
  const area = commercialCollection(contractCaseId, "billing");
  return { ...area, prefix: `${area.prefix}workflow:billing` };
}

export function issuedBillingCollection(contractCaseId: string): Collection {
  const area = commercialCollection(contractCaseId, "billing");
  return { ...area, prefix: `${area.prefix}workflow:issued-billing` };
}

export function emptyBillingRegister(contractCaseId: string): BillingRegister {
  addressId(contractCaseId);
  return {
    format: "sortsys-contract-billing-v1",
    contractCaseId,
    invoices: [],
  };
}

function billingRegisterModel(issued: boolean) {
  return defineDataModel<BillingRegister>({
    name: issued ? "issued-contract-billing" : "contract-billing-register",
    decode(input, object, area) {
      const binding = commercialDomain(area.domain);
      if (
        !binding ||
        binding.facet !== "billing" ||
        area.scope !== `commercial:${binding.id}`
      )
        throw new InvalidProtectedData();
      const collection = issued
        ? issuedBillingCollection(binding.id)
        : billingCollection(binding.id);
      if (object !== collection.prefix) throw new InvalidProtectedData();
      const value = record(input, ["format", "contractCaseId", "invoices"]);
      if (
        value.format !== "sortsys-contract-billing-v1" ||
        value.contractCaseId !== binding.id ||
        !Array.isArray(value.invoices) ||
        value.invoices.length > 10000
      )
        throw new InvalidProtectedData();
      const invoices = value.invoices.map(billingEntry);
      if (
        new Set(invoices.map((invoice) => invoice.id)).size !== invoices.length ||
        invoices.some((entry) => ISSUED_STATUSES.includes(entry.status) !== issued)
      )
        throw new InvalidProtectedData();
      return { format: value.format, contractCaseId: binding.id, invoices };
    },
    sources: () => [],
    tables: [],
  });
}

export const BILLING_REGISTER_MODEL = billingRegisterModel(false);
export const ISSUED_BILLING_REGISTER_MODEL = billingRegisterModel(true);

export function billingRequest(contractCaseId: string) {
  return {
    model: BILLING_REGISTER_MODEL,
    area: billingCollection(contractCaseId),
  };
}

export function issuedBillingRequest(contractCaseId: string) {
  return {
    model: ISSUED_BILLING_REGISTER_MODEL,
    area: issuedBillingCollection(contractCaseId),
  };
}

/** The active issued record supersedes its earlier draft in a recovered view. */
export function mergeBillingRegisters(
  drafts: BillingRegister,
  issued: BillingRegister,
): BillingRegister {
  if (drafts.contractCaseId !== issued.contractCaseId)
    throw new InvalidProtectedData();
  const invoices = new Map(drafts.invoices.map((entry) => [entry.id, entry]));
  for (const entry of issued.invoices) {
    const earlier = invoices.get(entry.id);
    if (earlier && earlier.kind !== entry.kind) throw new InvalidProtectedData();
    invoices.set(entry.id, entry);
  }
  return { ...drafts, invoices: [...invoices.values()] };
}

export function checkInvoiceCreation(
  register: BillingRegister,
  kind: InvoiceKind,
) {
  const active = register.invoices.filter(
    (invoice) => invoice.status !== "cancelled",
  );
  if (
    active.some(
      (invoice) =>
        invoice.kind === "invoice" || invoice.kind === "final_invoice",
    )
  )
    throw new Error("billing-already-settled");
  if (
    kind === "invoice" &&
    active.some((invoice) => invoice.kind === "progress_invoice")
  )
    throw new Error("billing-final-required");
  if (
    kind === "final_invoice" &&
    !active.some(
      (invoice) =>
        invoice.kind === "progress_invoice" &&
        ISSUED_STATUSES.includes(invoice.status),
    )
  )
    throw new Error("billing-progress-required");
}

export function billingContext(
  register: BillingRegister,
): QueryResult<"commercial.invoices.context"> {
  const progressInvoices = register.invoices
    .filter(
      (invoice) =>
        invoice.kind === "progress_invoice" &&
        ISSUED_STATUSES.includes(invoice.status),
    )
    .sort((left, right) => {
      const date = left.invoiceDate.localeCompare(right.invoiceDate);
      if (date) return date;
      const leftId = BigInt(addressId(left.id));
      const rightId = BigInt(addressId(right.id));
      if (leftId < rightId) return -1;
      if (leftId > rightId) return 1;
      return 0;
    })
    .map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber!,
      invoiceDate: invoice.invoiceDate,
      netAmount: invoice.netAmount,
      grossAmount: invoice.grossAmount,
      paidAmount: invoice.paidAmount,
      vatRate: invoice.vatRate,
    }));
  return {
    progressInvoices,
    hasInvoice: register.invoices.some(
      (invoice) => invoice.kind === "invoice" && invoice.status !== "cancelled",
    ),
    hasFinalInvoice: register.invoices.some(
      (invoice) =>
        invoice.kind === "final_invoice" && invoice.status !== "cancelled",
    ),
    vatRate: progressInvoices[0]?.vatRate ?? null,
  };
}

function permanentArea(
  id: string,
  facet: "master-data" | "billing",
  category: string,
): Collection {
  const area = commercialCollection(id, facet);
  return { ...area, prefix: immutablePrefix(area.scope, facet, category) };
}

export function invoiceSealRequest(id: string) {
  return {
    ...invoiceViewRequest(id, "master-data"),
    ids: [invoiceSealObject(id)],
  };
}

export function invoiceBillingRequest(id: string) {
  return {
    ...invoiceViewRequest(id, "billing"),
    ids: [invoiceBillingObject(id)],
  };
}

export function invoicePaymentRequest(id: string) {
  return invoiceViewRequest(id, "billing");
}

export function invoiceSealObject(id: string) {
  return immutableObject(`commercial:${id}`, "master-data", "invoice-seal", id);
}

export function invoiceBillingObject(id: string) {
  return immutableObject(`commercial:${id}`, "billing", "invoice", id);
}

export const INVOICE_BILLING_MODEL = defineDataModel<CommercialPayload>({
  name: "issued-invoice-billing",
  decode(input, object, area) {
    const binding = commercialDomain(area.domain);
    if (
      !binding ||
      binding.facet !== "billing" ||
      area.scope !== `commercial:${binding.id}` ||
      object !== invoiceBillingObject(binding.id)
    )
      throw new InvalidProtectedData();
    return commercialFacetPayload(input, binding.id, "billing");
  },
  sources: () => [],
  tables: [],
});

export const INVOICE_SEAL_MODEL = defineDataModel<InvoiceSeal>({
  name: "issued-invoice-seal",
  decode(input, object, area) {
    const binding = commercialDomain(area.domain);
    if (
      !binding ||
      binding.facet !== "master-data" ||
      area.scope !== `commercial:${binding.id}` ||
      object !== invoiceSealObject(binding.id)
    )
      throw new InvalidProtectedData();
    const value = record(input, [
      "format",
      "caseId",
      "master",
      "billingSignature",
      "document",
      "numberClaim",
    ]);
    if (
      value.format !== "sortsys-invoice-seal-v1" ||
      value.caseId !== binding.id
    )
      throw new InvalidProtectedData();
    sized(value.billingSignature as string, 64);
    const document = record(value.document, ["id", "version", "hash"]);
    addressId(document.id);
    if (
      typeof document.version !== "string" ||
      !/^[1-9]\d*$/.test(document.version) ||
      BigInt(document.version) > 9223372036854775807n
    )
      throw new InvalidProtectedData();
    sized(document.hash as string, 32);
    const numberClaim = record(value.numberClaim, ["object", "signature"]);
    if (
      typeof numberClaim.object !== "string" ||
      !/^immutable:organization:invoicing:billing:invoice-number:[\w-]{43}$/.test(
        numberClaim.object,
      )
    )
      throw new InvalidProtectedData();
    sized(numberClaim.signature as string, 64);
    const master = commercialFacetPayload(
      value.master,
      binding.id,
      "master-data",
    );
    const main = master.rows.find(
      (row) => row.table === "commercial_cases",
    )?.values;
    if (
      !main ||
      !isInvoice(main.kind as string) ||
      !ISSUED_STATUSES.includes(main.status as string) ||
      main.project_id === null ||
      main.parent_case_id === null
    )
      throw new InvalidProtectedData();
    const selected = master.rows.filter(
      (row) =>
        row.table === "commercial_documents" &&
        row.values.purpose === "invoice",
    );
    if (
      selected.length !== 1 ||
      publicId(selected[0]!.values.id) !== document.id ||
      selected[0]!.values.version !== document.version ||
      selected[0]!.values.read_only !== true
    )
      throw new InvalidProtectedData();
    return { ...value, master, document, numberClaim } as InvoiceSeal;
  },
  sources: () => [],
  tables: [],
});

export const INVOICE_PAYMENT_MODEL = defineDataModel<InvoicePayment>({
  name: "invoice-payment",
  decode(input, object, area) {
    const binding = commercialDomain(area.domain);
    if (
      !binding ||
      binding.facet !== "billing" ||
      area.scope !== `commercial:${binding.id}`
    )
      throw new InvalidProtectedData();
    const value = record(input, ["format", "caseId", "payment", "event"]);
    const payment = decodeBusinessRow(value.payment);
    const event = decodeBusinessRow(value.event);
    if (
      value.format !== "sortsys-invoice-payment-v1" ||
      value.caseId !== binding.id ||
      payment.table !== "commercial_invoice_payments" ||
      event.table !== "commercial_case_events" ||
      payment.values.case_id !== addressId(binding.id) ||
      event.values.case_id !== addressId(binding.id)
    )
      throw new InvalidProtectedData();
    if (
      object !==
      immutableObject(
        area.scope,
        "billing",
        "invoice-payment",
        publicId(payment.values.id),
      )
    )
      throw new InvalidProtectedData();
    if (
      commercialCents(billingMoney(payment.values.amount)) <= 0n ||
      event.values.action !== "payment_recorded" ||
      !["partially_paid", "paid"].includes(event.values.status as string) ||
      payment.values.created_by_user_id === null ||
      event.values.created_by_user_id !== payment.values.created_by_user_id
    )
      throw new InvalidProtectedData();
    return { format: value.format, caseId: binding.id, payment, event };
  },
  opened(value, object) {
    if (
      object.envelope.revision !== "0" &&
      object.envelope.author !==
        `user:${publicId(value.payment.values.created_by_user_id)}`
    )
      throw new InvalidProtectedData();
    return value;
  },
  sources: () => [],
  tables: [],
});

export type InvoiceView = InvoiceSeal | CommercialPayload | InvoicePayment;
export const INVOICE_VIEW_MODEL = defineDataModel<InvoiceView>({
  name: "invoice-records",
  decode(input, object, area) {
    const value = partialAddressRecord(input, [
      "format",
      "caseId",
      "schema",
      "facet",
      "rows",
      "master",
      "billingSignature",
      "document",
      "numberClaim",
      "payment",
      "event",
    ]);
    switch (value.format) {
      case "sortsys-invoice-seal-v1":
        return INVOICE_SEAL_MODEL.decode(input, object, area);
      case "sortsys-commercial-case-v1":
        return INVOICE_BILLING_MODEL.decode(input, object, area);
      case "sortsys-invoice-payment-v1":
        return INVOICE_PAYMENT_MODEL.decode(input, object, area);
      default:
        throw new InvalidProtectedData();
    }
  },
  opened(value, object) {
    if (value.format === "sortsys-invoice-payment-v1")
      return INVOICE_PAYMENT_MODEL.opened!(value, object);
    return value;
  },
  sources: () => [],
  tables: [],
});

export function invoiceViewRequest(
  id: string,
  facet: "master-data" | "billing",
) {
  const area = permanentArea(id, facet, "invoice");
  return {
    model: INVOICE_VIEW_MODEL,
    area: { ...area, prefix: area.prefix.slice(0, -1) },
  };
}

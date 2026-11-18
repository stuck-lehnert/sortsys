import { expect, test } from "bun:test";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { invoiceEntry, newInvoiceDetails } from "./commercialBilling";
import {
  billingContext,
  billingRequest,
  checkInvoiceCreation,
  emptyBillingRegister,
  invoiceBillingObject,
  invoiceBillingRequest,
  invoicePaymentRequest,
  invoiceSealObject,
  invoiceSealRequest,
  issuedBillingRequest,
  mergeBillingRegisters,
} from "./commercialBillingData";
import { splitCommercialRows } from "./commercialData";
import { commercialRequest } from "./commercialModel";
import { issuedCaseSnapshot } from "./commercialSnapshot";
import { row } from "./rowCodec.test.mjs";

function invoiceRows(status = "sent") {
  return [
    row("commercial_cases", {
      id: "3",
      project_id: "4",
      parent_case_id: "2",
      kind: "invoice",
      status,
      title: "Schluss der Fensterarbeiten",
      net_amount: "100.00",
      currency: "EUR",
      scope_item_ids: "[]",
    }),
    row("commercial_documents", {
      id: "5",
      case_id: "3",
      purpose: "invoice",
      phase: "89",
      version: "7",
      read_only: true,
      file_name: "17.x89",
      net_amount: "100.00",
    }),
    row("commercial_invoice_details", {
      case_id: "3",
      basis: "work",
      vat_rate: "19.00",
      invoice_number: "17",
      total_net: "100.00",
      deducted_net: "0.00",
      gross_amount: "119.00",
    }),
  ];
}

function entry(id, kind, status, netAmount = "100.00") {
  return {
    id,
    kind,
    status,
    invoiceNumber:
      status === "draft" || status === "cancelled" ? null : `26-${id}`,
    invoiceDate: "2026-11-12",
    netAmount,
    grossAmount: "119.00",
    paidAmount: "0.00",
    vatRate: "19.00",
  };
}

test("contract billing counts issued progress invoices and reserves settlement drafts", () => {
  const register = emptyBillingRegister("2");
  expect(() => checkInvoiceCreation(register, "final_invoice")).toThrow(
    "billing-progress-required",
  );
  register.invoices.push(
    entry("8", "progress_invoice", "sent"),
    entry("9", "progress_invoice", "cancelled"),
    entry("a", "progress_invoice", "draft"),
  );
  const context = billingContext(register);
  expect(context.progressInvoices.map((invoice) => invoice.id)).toEqual(["8"]);
  expect(context.vatRate).toBe("19.00");
  expect(() => checkInvoiceCreation(register, "invoice")).toThrow(
    "billing-final-required",
  );
  expect(() => checkInvoiceCreation(register, "final_invoice")).not.toThrow();
  register.invoices.push(entry("b", "final_invoice", "draft"));
  expect(billingContext(register).hasFinalInvoice).toBe(true);
  expect(() => checkInvoiceCreation(register, "progress_invoice")).toThrow(
    "billing-already-settled",
  );
  const request = billingRequest("2");
  expect(() =>
    request.model.decode(
      { ...register, invoices: [register.invoices[0], register.invoices[0]] },
      request.area.prefix,
      request.area,
    ),
  ).toThrow();
  expect(() =>
    request.model.decode(
      register,
      billingRequest("3").area.prefix,
      request.area,
    ),
  ).toThrow();
});

test("the current issued register replaces restored drafts without hiding other drafts", () => {
  const drafts = emptyBillingRegister("2");
  drafts.invoices.push(
    entry("8", "progress_invoice", "draft"),
    entry("a", "final_invoice", "draft"),
  );
  const issued = emptyBillingRegister("2");
  issued.invoices.push({
    ...entry("8", "progress_invoice", "partially_paid"),
    paidAmount: "35.00",
  });
  const restored = mergeBillingRegisters(drafts, issued);
  const context = billingContext(restored);
  expect(context.progressInvoices).toHaveLength(1);
  expect(context.progressInvoices[0]?.paidAmount).toBe("35.00");
  expect(context.hasFinalInvoice).toBe(true);
  expect(drafts.invoices[0]?.status).toBe("draft");
  const request = issuedBillingRequest("2");
  expect(request.model.decode(issued, request.area.prefix, request.area)).toEqual(
    issued,
  );
  expect(() =>
    request.model.decode(drafts, request.area.prefix, request.area),
  ).toThrow();
  expect(() => mergeBillingRegisters(drafts, emptyBillingRegister("3"))).toThrow();
});

test("draft invoice details use exact rates and allow lump sums only for progress invoices", () => {
  const details = newInvoiceDetails(
    "3",
    "progress_invoice",
    "lump_sum",
    "7.00",
    "2026-11-12T23:30:00Z",
  );
  expect(details.values).toMatchObject({
    basis: "lump_sum",
    vat_rate: "7.00",
    invoice_date: "2026-11-12",
    due_date: "2026-11-26",
    gross_amount: "0.00",
  });
  expect(() =>
    newInvoiceDetails("3", "invoice", "lump_sum", "19.00", "2026-11-12"),
  ).toThrow();
  expect(() =>
    newInvoiceDetails("3", "progress_invoice", "work", "100.01", "2026-11-12"),
  ).toThrow();
  expect(invoiceEntry(invoiceRows()).grossAmount).toBe("119.00");
});

test("immutable invoice views bind the signed billing snapshot and derive payments independently of mutable metadata", () => {
  const rows = invoiceRows();
  const split = splitCommercialRows("3", rows);
  const signature = base64(new Uint8Array(64));
  const seal = {
    format: "sortsys-invoice-seal-v1",
    caseId: "3",
    master: split.get("master-data"),
    billingSignature: signature,
    document: { id: "5", version: "7", hash: base64(new Uint8Array(32)) },
    numberClaim: {
      object: `immutable:organization:invoicing:billing:invoice-number:${base64(new Uint8Array(32))}`,
      signature,
    },
  };
  const sealed = invoiceSealRequest("3");
  expect(
    sealed.model.decode(seal, invoiceSealObject("3"), sealed.area),
  ).toEqual(seal);
  const originalMaster = structuredClone(split.get("master-data"));
  originalMaster.rows.find(
    (row) => row.table === "commercial_cases",
  ).values.title = "Nachträglich veränderte Bezeichnung";
  const parts = new Map(
    ["master-data", "billing"].map((facet) => [
      facet,
      {
        request: commercialRequest("3", facet),
        head: { domain: `commercial:3:${facet}`, sequence: "4" },
        signature,
        value: facet === "master-data" ? originalMaster : split.get(facet),
        canUpdate: true,
      },
    ]),
  );
  const payment = {
    format: "sortsys-invoice-payment-v1",
    caseId: "3",
    payment: row("commercial_invoice_payments", {
      id: "6",
      case_id: "3",
      amount: "19.00",
      created_by_user_id: "1",
    }),
    event: row("commercial_case_events", {
      id: "7",
      case_id: "3",
      action: "payment_recorded",
      previous_status: "sent",
      status: "partially_paid",
      created_by_user_id: "1",
    }),
  };
  const amounts = [
    { id: invoiceBillingObject("3"), signature, value: split.get("billing") },
    {
      id: "immutable:commercial:3:billing:invoice-payment:6",
      signature,
      value: payment,
    },
  ];
  const view = {
    documents(request) {
      return request.area.facet === "master-data"
        ? [{ id: invoiceSealObject("3"), signature, value: seal }]
        : amounts;
    },
  };
  const basis = {
    id: "3",
    values: rows,
    parts,
    visible: new Set(),
    seal: null,
  };
  const snapshot = issuedCaseSnapshot(view, basis);
  const main = snapshot.values.find((row) => row.table === "commercial_cases");
  expect(main.values.title).toBe("Schluss der Fensterarbeiten");
  expect(main.values.status).toBe("partially_paid");
  amounts[0].signature = "unbound-snapshot";
  expect(() => issuedCaseSnapshot(view, basis)).toThrow();
  const request = invoicePaymentRequest("3");
  expect(() =>
    request.model.opened(payment, {
      envelope: { revision: "1", author: "user:2" },
    }),
  ).toThrow();
  expect(
    request.model.opened(payment, {
      envelope: { revision: "1", author: "user:1" },
    }),
  ).toEqual(payment);
  expect(() =>
    invoiceBillingRequest("4").model.decode(
      split.get("billing"),
      invoiceBillingObject("3"),
      invoiceBillingRequest("4").area,
    ),
  ).toThrow();
});

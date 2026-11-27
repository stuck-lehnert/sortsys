import type { Client } from "@sortsys/v2-client";
import type { GaebXmlProcessor, ValidatedInvoice } from "@sortsys/gaeb";
import {
  documentHeadHash,
  immutableObject,
  InvalidProtectedData,
  record,
} from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import {
  ProtectedWriteConflict,
  type DocumentPublication,
  type PreparedWrites,
} from "./atomicWrites";
import { calendarDay } from "./calendarDays";
import { commercialDocumentStore } from "./commercialDocumentContent";
import {
  commercialCents,
  commercialMoney,
  isInvoice,
  isAcceptedContract,
  splitCommercialRows,
  wireCommercialCase,
  wireCommercialInvoice,
} from "./commercialData";
import {
  billingContext,
  billingEntry,
  billingMoney,
  billingRate,
  billingRequest,
  checkInvoiceCreation,
  emptyBillingRegister,
  invoiceBillingObject,
  invoiceBillingRequest,
  invoicePaymentRequest,
  invoiceSealObject,
  invoiceSealRequest,
  issuedBillingRequest,
  ISSUED_STATUSES,
  mergeBillingRegisters,
  type BillingEntry,
  type InvoiceKind,
  type InvoiceSeal,
} from "./commercialBillingData";
import type { CommercialFacet } from "./commercialAreas";
import { copyCommercialRows } from "./commercialRows";
import { caseGuards, type CaseSnapshot } from "./commercialSnapshot";
import { createInvoiceNumbers } from "./invoiceNumbers";
import { financialInputsReadable } from "./documentEditor";
import { newProductRowId, publicId } from "./products";
import { financialObject, financialRequest } from "./projectFinancialData";
import { required } from "./protectedObjects";
import { createBusinessRow, type BusinessRow } from "./rowCodec";
import type { DataRuntime, DataView, PreparedData } from "./runtime/runtime";

export type CaseChange = {
  snapshot: CaseSnapshot;
  values: BusinessRow[];
  facets: CommercialFacet[];
};
type BillingHooks = {
  read(id: string, fresh?: boolean): Promise<CaseSnapshot>;
  afterStaging(previous: CaseSnapshot): Promise<CaseSnapshot>;
  persist(
    changes: CaseChange[],
    guards: PreparedWrites["head"][],
    additional: PreparedWrites[],
    documents?: DocumentPublication[],
  ): Promise<void>;
};

function billingError(error: unknown): never {
  if (!(error instanceof Error)) throw error;
  const messages: Record<string, () => string> = {
    "billing-already-settled": () =>
      uiText(
        "Für diesen Auftrag besteht bereits eine Rechnung oder Schlussrechnung.",
        "This contract already has an invoice or final invoice.",
      ),
    "billing-final-required": () =>
      uiText(
        "Nach Abschlagsrechnungen wird eine Schlussrechnung benötigt.",
        "A final invoice is required after progress invoices.",
      ),
    "billing-progress-required": () =>
      uiText(
        "Eine Schlussrechnung setzt mindestens eine ausgestellte Abschlagsrechnung voraus.",
        "A final invoice requires an issued progress invoice.",
      ),
    "invoice-address": () =>
      uiText(
        "Die Rechnungsadressen müssen vollständig sein.",
        "Complete the invoice addresses.",
      ),
    "invoice-tax-number": () =>
      uiText(
        "Für die Rechnung fehlt die Steuernummer des Unternehmens.",
        "The organization's tax number is missing.",
      ),
    "invoice-vat-chain": () =>
      uiText(
        "Die Umsatzsteuer muss mit den bisherigen Abschlagsrechnungen übereinstimmen.",
        "VAT must match the previous progress invoices.",
      ),
    "invoice-previous-invoices": () =>
      uiText(
        "Die Abschlagsrechnungen haben sich geändert. Die Schlussrechnung muss neu berechnet werden.",
        "Progress invoices changed. Recalculate the final invoice.",
      ),
  };
  const message = messages[error.message];
  if (message) throw new Error(message());
  if (error.message.startsWith("invoice-")) {
    throw new Error(
      uiText(
        "Die Rechnung enthält ungültige Angaben oder widersprüchliche Beträge.",
        "The invoice contains invalid information or inconsistent amounts.",
      ),
    );
  }
  throw error;
}

function invoiceRow(rows: BusinessRow[]): BusinessRow {
  const found = rows.filter(
    (row) => row.table === "commercial_invoice_details",
  );
  if (found.length !== 1) throw new InvalidProtectedData();
  return found[0]!;
}

export function newInvoiceDetails(
  caseId: string,
  kind: InvoiceKind,
  basis: unknown,
  rate: unknown,
  now: string,
): BusinessRow {
  const selectedBasis = basis ?? "work";
  if (
    !["work", "lump_sum"].includes(selectedBasis as string) ||
    (kind !== "progress_invoice" && selectedBasis !== "work")
  ) {
    throw new InvalidProtectedData();
  }
  const date = calendarDay(now.slice(0, 10));
  const due = new Date(`${date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + 14);
  return createBusinessRow("commercial_invoice_details", {
    case_id: addressId(caseId),
    basis: selectedBasis,
    vat_rate: billingRate(rate ?? "19.00"),
    invoice_number: null,
    invoice_date: date,
    due_date: calendarDay(due.toISOString().slice(0, 10)),
    service_start: date,
    service_end: date,
    total_net: "0.00",
    deducted_net: "0.00",
    gross_amount: "0.00",
  });
}

export function applyInvoiceDetails(
  rows: BusinessRow[],
  details: ValidatedInvoice["details"],
) {
  const invoice = invoiceRow(rows);
  Object.assign(invoice.values, {
    invoice_date: details.invoiceDate,
    due_date: details.dueDate,
    service_start: details.serviceStart,
    service_end: details.serviceEnd,
    total_net: details.totalNet,
    deducted_net: details.deductedNet,
    gross_amount: details.grossAmount,
  });
}

export function invoiceEntry(rows: BusinessRow[]): BillingEntry {
  const current = wireCommercialCase(rows);
  const details = wireCommercialInvoice(rows);
  if (!details || !isInvoice(current.kind)) throw new InvalidProtectedData();
  return billingEntry({
    id: current.id,
    kind: current.kind,
    status: current.status,
    invoiceNumber: details.invoiceNumber,
    invoiceDate: details.invoiceDate,
    netAmount: current.netAmount ?? "0.00",
    grossAmount: details.grossAmount,
    paidAmount: details.paidAmount,
    vatRate: details.vatRate,
  });
}

function readRegisters(view: DataView, contractId: string) {
  const draftRequest = billingRequest(contractId);
  const issuedRequest = issuedBillingRequest(contractId);
  const drafts = view.documents(draftRequest);
  const issued = view.documents(issuedRequest);
  if (drafts.length !== 1 || issued.length !== 1)
    throw new InvalidProtectedData();
  return {
    draft: drafts[0]!,
    issued: issued[0]!,
    register: mergeBillingRegisters(drafts[0]!.value, issued[0]!.value),
  };
}

export function createCommercialBilling(
  client: Client,
  runtime: DataRuntime,
  signal: AbortSignal,
  processor: GaebXmlProcessor,
  hooks: BillingHooks,
) {
  const numbers = createInvoiceNumbers(client, signal);

  async function contract(id: string) {
    const basis = await hooks.read(id, true);
    const current = wireCommercialCase(basis.values);
    if (
      !isAcceptedContract(current) ||
      !current.projectId ||
      !basis.parts.has("billing")
    ) {
      throw new InvalidProtectedData();
    }
    return basis;
  }

  async function register(contractCaseId: string) {
    const draftRequest = billingRequest(contractCaseId);
    return runtime.read(
      [draftRequest, issuedBillingRequest(contractCaseId)],
      (view) => ({
        value: readRegisters(view, contractCaseId).register,
        head: view.head(draftRequest),
      }),
    );
  }

  async function prepareEntry(
    parent: string,
    rows: BusinessRow[],
    creating = false,
  ) {
    const entry = invoiceEntry(rows);
    const draftRequest = billingRequest(parent);
    const issuedRequest = issuedBillingRequest(parent);
    return runtime.prepare([draftRequest, issuedRequest], (tx) => {
      const previous = readRegisters(tx, parent);
      const existing = previous.register.invoices.find(
        (invoice) => invoice.id === entry.id,
      );
      if (creating) {
        if (existing) throw new ProtectedWriteConflict();
        try {
          checkInvoiceCreation(previous.register, entry.kind);
        } catch (error) {
          billingError(error);
        }
        const rate = billingContext(previous.register).vatRate;
        if (
          rate !== null &&
          commercialCents(rate) !== commercialCents(entry.vatRate)
        )
          billingError(new Error("invoice-vat-chain"));
      } else if (
        !existing ||
        (existing.status !== "draft" &&
          existing.status !== "sent" &&
          existing.status !== "partially_paid")
      ) {
        throw new ProtectedWriteConflict();
      }
      const issued = ISSUED_STATUSES.includes(entry.status);
      if (issued) {
        tx.edit(issuedRequest, previous.issued.id, (value) => {
          value.invoices = value.invoices.filter(
            (invoice) => invoice.id !== entry.id,
          );
          value.invoices.push(entry);
        });
      }
      const hasDraft = previous.draft.value.invoices.some(
        (invoice) => invoice.id === entry.id,
      );
      if (!issued || hasDraft) {
        tx.edit(draftRequest, previous.draft.id, (value) => {
          value.invoices = value.invoices.filter(
            (invoice) => invoice.id !== entry.id,
          );
          if (!issued) value.invoices.push(entry);
        });
      }
    });
  }

  async function validate(
    basis: CaseSnapshot,
    xml: string,
    declared: unknown,
    invoiceNumber?: string,
  ) {
    const current = wireCommercialCase(basis.values);
    if (
      !isInvoice(current.kind) ||
      current.status !== "draft" ||
      basis.seal ||
      !current.parentCaseId ||
      !current.projectId
    ) {
      throw new InvalidProtectedData();
    }
    const parent = await contract(current.parentCaseId);
    if (wireCommercialCase(parent.values).projectId !== current.projectId)
      throw new InvalidProtectedData();
    const selected = await register(current.parentCaseId);
    const own = selected.value.invoices.find(
      (invoice) => invoice.id === basis.id,
    );
    if (!own || own.status !== "draft" || own.kind !== current.kind)
      throw new InvalidProtectedData();
    const settled = selected.value.invoices.some(
      (invoice) =>
        invoice.id !== basis.id &&
        ["invoice", "final_invoice"].includes(invoice.kind) &&
        ["sent", "partially_paid", "paid"].includes(invoice.status),
    );
    if (settled) billingError(new Error("billing-already-settled"));
    const previousInvoices = billingContext(selected.value).progressInvoices;
    try {
      const validated = await processor.invoice(
        xml,
        {
          kind: current.kind,
          vatRate: invoiceRow(basis.values).values.vat_rate as string,
          previousInvoices,
          netAmount: billingMoney(declared),
          invoiceNumber,
          requireAddresses: invoiceNumber !== undefined,
        },
        signal,
      );
      return { validated, guards: [...caseGuards(parent), selected.head] };
    } catch (error) {
      billingError(error);
    }
  }

  return {
    close: numbers.close,
    validate,
    prepareEntry,
    async initialize(contractCaseId: string) {
      const requests = [
        billingRequest(contractCaseId),
        issuedBillingRequest(contractCaseId),
      ];
      return runtime.prepare(requests, (tx) => {
        for (const request of requests) {
          if (tx.documents(request).length) throw new ProtectedWriteConflict();
          tx.create(
            request,
            request.area.prefix,
            emptyBillingRegister(contractCaseId),
          );
        }
      });
    },
    async context(input: unknown) {
      const data = record(input, ["contractCaseId"]);
      addressId(data.contractCaseId);
      await contract(data.contractCaseId as string);
      return billingContext((await register(data.contractCaseId as string)).value);
    },
    async cancel(basis: CaseSnapshot, rows: BusinessRow[]) {
      const current = wireCommercialCase(rows);
      if (!current.parentCaseId || basis.seal || current.status !== "cancelled")
        throw new InvalidProtectedData();
      return prepareEntry(current.parentCaseId, rows);
    },
    async issue(input: unknown) {
      const data = record(input, ["id"]);
      addressId(data.id);
      const id = data.id as string;
      const basis = await hooks.read(id, true);
      if (basis.seal) return { success: true };
      const current = wireCommercialCase(basis.values);
      if (
        !current.projectId ||
        !current.parentCaseId ||
        current.netAmount === null
      )
        throw new InvalidProtectedData();
      const documents = basis.values.filter(
        (row) =>
          row.table === "commercial_documents" &&
          row.values.purpose === "invoice",
      );
      if (documents.length !== 1) throw new InvalidProtectedData();
      const documentId = publicId(documents[0]!.values.id);
      const store = await commercialDocumentStore(
        client,
        `commercial:${id}`,
        signal,
      );
      const prepared: PreparedData<unknown>[] = [];
      try {
        const previous = await store.head(documentId);
        if (!previous || previous.locked) throw new ProtectedWriteConflict();
        const content = await store.load(previous, processor);
        if (
          content.layout.identity.phase !== "89" ||
          content.layout.signed ||
          !content.access.writable.includes("billing") ||
          !financialInputsReadable(
            content.access,
            "89",
            current.kind,
            content.missing,
          )
        ) {
          throw new InvalidProtectedData();
        }
        const checked = await validate(basis, content.xml, current.netAmount);
        const plan = await numbers.plan({
          caseId: id,
          projectId: current.projectId,
          invoiceDate: checked.validated.details.invoiceDate,
        });
        const numbered = await validate(
          basis,
          content.xml,
          current.netAmount,
          plan.number,
        );
        // Number only the readable billing fragment. Unread extensions retain
        // their original signed references when the whole document is locked.
        const partition = await processor.updateView(
          numbered.validated.xml,
          current.kind,
          {
            layout: content.layout,
            fragments: [...content.fragments.values()].flat(),
          },
          ["billing"],
          signal,
        );
        if (
          content.complete &&
          !(
            await processor.validate(
              numbered.validated.xml,
              partition.layout.identity,
              signal,
            )
          ).valid
        )
          throw new InvalidProtectedData();
        const now = new Date().toISOString();
        const publication = await store.prepare(documentId, partition, {
          previous,
          modifiedAt: now,
          readOnly: true,
          locked: true,
        });
        const refreshed = await hooks.afterStaging(basis);
        const session = await required(
          client.query("auth.sessionInfo", undefined, {
            strategy: "network-only",
          }),
        );
        const rows = copyCommercialRows(basis.values);
        const main = rows.find((row) => row.table === "commercial_cases")!;
        main.values.status = "sent";
        main.values.modified_at = now;
        const selectedDocument = rows.find(
          (row) =>
            row.table === "commercial_documents" &&
            publicId(row.values.id) === documentId,
        )!;
        Object.assign(selectedDocument.values, {
          read_only: true,
          version: publication.head.version,
          file_name: `${plan.number}.x89`,
          size_bytes: String(
            new TextEncoder().encode(numbered.validated.xml).length,
          ),
          modified_at: now,
        });
        applyInvoiceDetails(rows, numbered.validated.details);
        invoiceRow(rows).values.invoice_number = plan.number;
        rows.push(
          createBusinessRow("commercial_case_events", {
            id: newProductRowId(),
            case_id: addressId(id),
            action: "invoice_issued",
            previous_status: "draft",
            status: "sent",
            created_by_user_id: addressId(session.user.id),
            created_at: now,
          }),
        );
        const number = await plan.prepare();
        prepared.push(number);
        const entry = await prepareEntry(current.parentCaseId, rows);
        prepared.push(entry);
        const financial = financialRequest(current.projectId, "invoice", true);
        const frozen = invoiceBillingRequest(id);
        const split = splitCommercialRows(id, rows);
        const amounts = await runtime.prepare([frozen, financial], (tx) => {
          tx.create(frozen, invoiceBillingObject(id), split.get("billing")!);
          const row = createBusinessRow("project_financial_entries", {
            id: addressId(id),
            project_id: addressId(current.projectId!),
            type: "invoice",
            amount: Number(current.netAmount),
            comment: `${plan.number}: ${current.title}`,
            commercial_case_id: addressId(id),
            created_by_user_id: addressId(session.user.id),
            created_at: now,
          });
          tx.create(financial, financialObject(row), {
            format: "sortsys-project-financial-v1",
            row,
            exactAmount: current.netAmount,
          });
        });
        prepared.push(amounts);
        const billingSignature = amounts.versions.find(
          (version) => version.id === invoiceBillingObject(id),
        )?.signature;
        const claimSignature = number.versions.find(
          (version) => version.id === plan.claim,
        )?.signature;
        if (!billingSignature || !claimSignature)
          throw new InvalidProtectedData();
        const seal: InvoiceSeal = {
          format: "sortsys-invoice-seal-v1",
          caseId: id,
          master: split.get("master-data")!,
          billingSignature,
          document: {
            id: documentId,
            version: publication.head.version,
            hash: await documentHeadHash(publication.head),
          },
          numberClaim: { object: plan.claim, signature: claimSignature },
        };
        const sealRequest = invoiceSealRequest(id);
        const sealed = await runtime.prepare([sealRequest], (tx) =>
          tx.create(sealRequest, invoiceSealObject(id), seal),
        );
        prepared.push(sealed);
        await hooks.persist(
          [
            {
              snapshot: refreshed,
              values: rows,
              facets: ["master-data", "billing"],
            },
          ],
          [...numbered.guards, ...prepared.flatMap((part) => part.guards)],
          prepared.flatMap((part) => part.groups),
          [publication],
        );
        return { success: true };
      } finally {
        for (const part of prepared) part.close();
        store.close();
      }
    },
    async payment(input: unknown) {
      const data = partialAddressRecord(input, [
        "id",
        "amount",
        "paidOn",
        "reference",
        "operationId",
      ]);
      addressId(data.id);
      const id = data.id as string;
      const operationId =
        data.operationId == null
          ? publicId(newProductRowId())
          : (data.operationId as string);
      addressId(operationId);
      const amount = billingMoney(data.amount);
      const paidOn = calendarDay(data.paidOn);
      const reference = addressText(data.reference, false, 255) ?? "";
      if (
        commercialCents(amount) === 0n ||
        paidOn > new Date().toISOString().slice(0, 10)
      )
        throw new InvalidProtectedData();
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      const actor = addressId(session.user.id);
      const basis = await hooks.read(id, true);
      const current = wireCommercialCase(basis.values);
      const payments = invoicePaymentRequest(id);
      const object = immutableObject(
        `commercial:${id}`,
        "billing",
        "invoice-payment",
        operationId,
      );
      const existing = await runtime.read([payments], (view) =>
        view.documents(payments).find((document) => document.id === object),
      );
      if (existing) {
        if (existing.value.format !== "sortsys-invoice-payment-v1")
          throw new InvalidProtectedData();
        const old = existing.value.payment.values;
        if (
          old.amount !== amount ||
          old.paid_on !== paidOn ||
          old.reference !== reference ||
          old.created_by_user_id !== actor
        )
          throw new ProtectedWriteConflict();
        return { success: true };
      }
      if (
        !basis.seal ||
        !["sent", "partially_paid"].includes(current.status) ||
        !current.parentCaseId
      )
        throw new InvalidProtectedData();
      const invoice = wireCommercialInvoice(basis.values);
      if (!invoice) throw new InvalidProtectedData();
      const paid =
        commercialCents(invoice.paidAmount) + commercialCents(amount);
      const gross = commercialCents(invoice.grossAmount);
      if (paid > gross)
        throw new Error(
          uiText(
            "Die Zahlung übersteigt den offenen Rechnungsbetrag.",
            "The payment exceeds the outstanding amount.",
          ),
        );
      const status = paid === gross ? "paid" : "partially_paid";
      const now = new Date().toISOString();
      const rows = copyCommercialRows(basis.values);
      const main = rows.find((row) => row.table === "commercial_cases")!;
      main.values.status = status;
      main.values.modified_at = now;
      const payment = createBusinessRow("commercial_invoice_payments", {
        id: addressId(operationId),
        case_id: addressId(id),
        amount,
        paid_on: paidOn,
        reference,
        created_by_user_id: actor,
        created_at: now,
      });
      const event = createBusinessRow("commercial_case_events", {
        id: newProductRowId(),
        case_id: addressId(id),
        action: "payment_recorded",
        previous_status: current.status,
        status,
        created_by_user_id: actor,
        created_at: now,
      });
      rows.push(payment, event);
      const prepared: PreparedData<unknown>[] = [];
      try {
        prepared.push(
          await runtime.prepare([payments], (tx) =>
            tx.create(payments, object, {
              format: "sortsys-invoice-payment-v1",
              caseId: id,
              payment,
              event,
            }),
          ),
        );
        prepared.push(await prepareEntry(current.parentCaseId, rows));
        await hooks.persist(
          [{ snapshot: basis, values: rows, facets: ["master-data"] }],
          prepared.flatMap((part) => part.guards),
          prepared.flatMap((part) => part.groups),
        );
        return { success: true };
      } finally {
        for (const part of prepared) part.close();
      }
    },
  };
}

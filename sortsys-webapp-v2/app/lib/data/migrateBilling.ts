import type { Client } from "@sortsys/v2-client";
import {
  documentHeadHash,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { invoiceEntry } from "./commercialBilling";
import {
  billingRequest,
  emptyBillingRegister,
  invoiceBillingObject,
  invoiceBillingRequest,
  invoiceSealObject,
  invoiceSealRequest,
  issuedBillingRequest,
  ISSUED_STATUSES,
  type InvoiceSeal,
} from "./commercialBillingData";
import { commercialDocumentStore } from "./commercialDocumentContent";
import {
  isInvoice,
  splitCommercialRows,
  wireCommercialCase,
  wireCommercialInvoice,
} from "./commercialData";
import { copyCommercialRows } from "./commercialRows";
import {
  copyProtectedCollection,
  copyProtectedSingletons,
  lazyCopyAttester,
} from "./copyCollection";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { createInvoiceNumbers } from "./invoiceNumbers";
import {
  invoiceCounterRequest,
  invoiceNumberObject,
  invoiceNumberRequest,
  nextInvoiceNumber,
  type InvoiceNumberClaim,
} from "./invoiceNumberData";
import { publicId } from "./products";
import { protectedCollection, protectedCollections } from "./protectedObjects";
import type { BusinessRow } from "./rowCodec";

export type CommercialSource = { id: string; rows: BusinessRow[] };

export async function readCommercialSource(
  source: BusinessDatabase,
): Promise<CommercialSource[]> {
  const cases = await readBusinessRows(source, "commercial_cases");
  const groups = new Map(cases.map((row) => [row.values.id as string, [row]]));
  for (const table of [
    "commercial_documents",
    "commercial_case_events",
    "commercial_invoice_details",
    "commercial_invoice_payments",
  ]) {
    for (const row of await readBusinessRows(source, table)) {
      const group = groups.get(row.values.case_id as string);
      if (!group) throw new InvalidProtectedData();
      group.push(row);
    }
  }
  return [...groups].map(([id, rows]) => ({ id: publicId(id), rows }));
}

/** The contract register includes every invoice, including children whose
 * individual case keys may later be unavailable to a partial reader. */
export async function prepareBillingRegisters(
  client: Client,
  entries: CommercialSource[],
  signal: AbortSignal,
) {
  const registers = new Map(
    entries
      .filter((entry) =>
        ["offer", "variation", "alternative"].includes(
          wireCommercialCase(entry.rows).kind,
        ),
      )
      .map((entry) => [entry.id, emptyBillingRegister(entry.id)]),
  );
  for (const entry of entries) {
    const current = wireCommercialCase(entry.rows);
    if (!isInvoice(current.kind)) continue;
    const parent = current.parentCaseId
      ? registers.get(current.parentCaseId)
      : undefined;
    if (!parent) throw new InvalidProtectedData();
    parent.invoices.push(invoiceEntry(entry.rows));
  }
  for (const register of registers.values()) {
    register.invoices.sort((left, right) => left.id.localeCompare(right.id));
  }
  if (!registers.size) return;

  const open = await protectedCollections(client, signal);
  const attest = lazyCopyAttester(client, signal);

  // Drafts and issued invoices share a domain. Finish and confirm each
  // draft page before reading the updated heads for issued registers.
  for (const issued of [false, true]) {
    const requestFor = issued ? issuedBillingRequest : billingRequest;
    const copies = [...registers.values()].map((register) => {
      const { area, model } = requestFor(register.contractCaseId);
      const invoices = register.invoices.filter(
        (invoice) => ISSUED_STATUSES.includes(invoice.status) === issued,
      );

      return {
        area,
        row: { id: area.prefix, value: { ...register, invoices } },
        validate: (value: unknown, object: string) =>
          model.decode(value, object, area),
        attest,
      };
    });
    await copyProtectedSingletons(client, copies, signal, open);
  }
}

/** Seal issued source invoices only after their original XML is encrypted and
 * irreversibly locked. Neither recovery nor clearing an OTS proof opens them. */
export async function prepareIssuedInvoices(
  client: Client,
  source: BusinessDatabase,
  signal: AbortSignal,
) {
  const entries = await readCommercialSource(source);
  signal.throwIfAborted();

  // Reject inconsistent claims before publishing any part of the ledger.
  const used = new Set<string>();
  const invoices = entries.flatMap((entry) => {
    const current = wireCommercialCase(entry.rows);
    if (!isInvoice(current.kind)) return [];

    const invoice = wireCommercialInvoice(entry.rows);
    if (!invoice?.invoiceNumber) return [];

    const number = invoice.invoiceNumber;
    const { projectId, parentCaseId, status } = current;
    if (!projectId || !parentCaseId || used.has(number))
      throw new InvalidProtectedData();

    used.add(number);
    return [{ entry, projectId, status, invoiceDate: invoice.invoiceDate, number }];
  });

  for (const row of await readBusinessRows(source, "commercial_invoice_counters")) {
    signal.throwIfAborted();
    const legacy = row.values.scope;
    if (typeof legacy !== "string") throw new InvalidProtectedData();

    const scope = legacy.startsWith("project:")
      ? `project:${publicId(legacy.slice("project:".length))}`
      : legacy;
    const request = invoiceCounterRequest(scope);
    const value = {
      format: "sortsys-invoice-counter-v1",
      scope,
      nextNumber: nextInvoiceNumber(row.values.next_number),
    };
    await copyProtectedCollection(
      client,
      request.area,
      [{ id: request.area.prefix, value }],
      (value, object) => request.model.decode(value, object, request.area),
      signal,
    );
  }

  signal.throwIfAborted();
  if (!invoices.length) return;

  const numbers = createInvoiceNumbers(client, signal);
  try {
    const namespace = await numbers.namespace();
    for (const { entry, projectId, status, invoiceDate, number } of invoices) {
      signal.throwIfAborted();

      const object = await invoiceNumberObject(namespace.value, number);
      const request = invoiceNumberRequest(object);
      const value: InvoiceNumberClaim = {
        format: "sortsys-invoice-number-v1",
        caseId: entry.id,
        projectId,
        invoiceDate,
        number,
      };
      await copyProtectedCollection(
        client,
        request.area,
        [{ id: object, value }],
        (value, object) => request.model.decode(value, object, request.area),
        signal,
      );
      if (!ISSUED_STATUSES.includes(status)) continue;
      const rows = copyCommercialRows(entry.rows);
      const selected = rows.filter(
        (row) =>
          row.table === "commercial_documents" &&
          row.values.purpose === "invoice",
      );
      if (selected.length !== 1) throw new InvalidProtectedData();
      const document = selected[0]!;
      const store = await commercialDocumentStore(
        client,
        `commercial:${entry.id}`,
        signal,
      );
      try {
        const head = await store.head(publicId(document.values.id));
        if (
          !head ||
          !head.locked ||
          !head.readOnly ||
          head.version !== document.values.version
        )
          throw new InvalidProtectedData();
        document.values.read_only = true;
        const split = splitCommercialRows(entry.id, rows);
        const billing = invoiceBillingRequest(entry.id);
        await copyProtectedCollection(
          client,
          billing.area,
          [
            {
              id: invoiceBillingObject(entry.id),
              value: split.get("billing")!,
            },
          ],
          (value, object) => billing.model.decode(value, object, billing.area),
          signal,
          true,
        );
        const claim = await protectedCollection(client, request.area, signal);
        const amounts = await protectedCollection(client, billing.area, signal);
        try {
          const claimSignature = (await claim.get(object)).envelope.signature;
          const billingSignature = (
            await amounts.get(invoiceBillingObject(entry.id))
          ).envelope.signature;
          const seal: InvoiceSeal = {
            format: "sortsys-invoice-seal-v1",
            caseId: entry.id,
            master: split.get("master-data")!,
            billingSignature,
            document: {
              id: head.id,
              version: head.version,
              hash: await documentHeadHash(head),
            },
            numberClaim: { object, signature: claimSignature },
          };
          const sealed = invoiceSealRequest(entry.id);
          await copyProtectedCollection(
            client,
            sealed.area,
            [{ id: invoiceSealObject(entry.id), value: seal }],
            (value, object) => sealed.model.decode(value, object, sealed.area),
            signal,
            true,
          );
        } finally {
          claim.close();
          amounts.close();
        }
      } finally {
        store.close();
      }
    }
  } finally {
    numbers.close();
  }
}

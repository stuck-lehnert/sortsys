import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { COMMERCIAL_FACETS, type CommercialFacet } from "./commercialAreas";
import { publicId } from "./products";
import {
  decodeBusinessFields,
  decodeBusinessRow,
  type BusinessRow,
} from "./rowCodec";
import { businessSchema, tableDefinition } from "./schema";

export const COMMERCIAL_QUERIES = new Set([
  "commercial.cases.list",
  "commercial.cases.overview",
  "commercial.cases.headers",
  "commercial.cases.get",
  "commercial.documents.get",
  "commercial.documents.download",
  "commercial.invoices.context",
]);
export const COMMERCIAL_MUTATIONS = new Set([
  "commercial.cases.create",
  "commercial.cases.update",
  "commercial.cases.transition",
  "commercial.cases.createProject",
  "commercial.cases.adoptContract",
  "commercial.documents.save",
  "commercial.documents.create",
  "commercial.documents.finalize",
  "commercial.invoices.issue",
  "commercial.invoices.recordPayment",
]);
export const COMMERCIAL_TABLES = [
  "commercial_cases",
  "commercial_documents",
  "commercial_case_events",
  "commercial_invoice_details",
  "commercial_invoice_payments",
] as const;
export type CommercialTable = (typeof COMMERCIAL_TABLES)[number];
export type CommercialCase = Omit<
  QueryResult<"commercial.cases.get">["case"],
  "scopeItemIds"
> & { scopeItemIds: string[] };
export type CommercialFragment = {
  table: CommercialTable;
  values: Record<string, unknown>;
};
export type CommercialPayload = {
  format: "sortsys-commercial-case-v1";
  schema: string;
  caseId: string;
  facet: CommercialFacet;
  rows: CommercialFragment[];
};
export const COMMERCIAL_KINDS = [
  "offer",
  "variation",
  "alternative",
  "subcontract",
  "measurement",
  "procurement",
  "calculation",
  "invoice",
  "progress_invoice",
  "final_invoice",
] as const;
export const COMMERCIAL_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "cancelled",
  "requested",
  "awarded",
  "confirmed",
  "submitted",
  "approved",
  "partially_paid",
  "paid",
] as const;
export type InvoiceKind = "invoice" | "progress_invoice" | "final_invoice";
export const isInvoice = (kind: string): kind is InvoiceKind =>
  ["invoice", "progress_invoice", "final_invoice"].includes(kind);
export function isAcceptedContract(value: {
  kind: string;
  status: string;
}): boolean {
  if (value.status !== "accepted") return false;
  return ["offer", "variation", "alternative"].includes(value.kind);
}
const keys = (table: string): string[] =>
  table === "commercial_cases"
    ? ["id"]
    : table === "commercial_invoice_details"
      ? ["case_id"]
      : ["id", "case_id"];
const rowKey = (row: CommercialFragment) =>
  `${row.table}:${keys(row.table)
    .map((key) => row.values[key])
    .join(":")}`;

/** Prices never inherit the master-data key. Supplier prices are procurement
 * data; invoices and internal calculations have their own independent keys. */
export function commercialAmountFacet(
  kind: string,
  purpose?: string,
): CommercialFacet {
  if (isInvoice(kind) || purpose === "invoice") return "billing";
  if (kind === "calculation" || purpose === "calculation") return "calculation";
  if (
    ["procurement", "subcontract"].includes(kind) ||
    [
      "price_inquiry",
      "supplier_offer",
      "purchase_order",
      "supplier_confirmation",
    ].includes(purpose ?? "")
  )
    return "procurement";
  return "offer-prices";
}
function owner(
  table: string,
  column: string,
  kind: string,
  purpose?: string,
): CommercialFacet {
  if (
    ["commercial_invoice_details", "commercial_invoice_payments"].includes(
      table,
    )
  )
    return "billing";
  if (column === "net_amount") return commercialAmountFacet(kind, purpose);
  if (table === "commercial_cases" && column === "notes") return "calculation";
  if (table === "commercial_cases" && column === "scope_item_ids")
    return "scope";
  if (table === "commercial_documents" && column === "object_key")
    return "attachment";
  return "master-data";
}
function columns(
  table: string,
  facet: CommercialFacet,
  kind: string,
  purpose?: string,
): string[] {
  const owned = tableDefinition(table)
    .columns.map((c) => c.name)
    .filter(
      (column) =>
        !keys(table).includes(column) &&
        owner(table, column, kind, purpose) === facet,
    );
  return owned.length ? [...keys(table), ...owned] : [];
}
function checkRows(id: string, inputs: unknown[]): BusinessRow[] {
  addressId(id);
  if (inputs.length > 10000) throw new InvalidProtectedData();
  const rows = inputs.map(decodeBusinessRow);
  const cases = rows.filter((row) => row.table === "commercial_cases");
  if (
    cases.length !== 1 ||
    publicId(cases[0].values.id) !== id ||
    !COMMERCIAL_KINDS.includes(
      cases[0].values.kind as (typeof COMMERCIAL_KINDS)[number],
    ) ||
    !COMMERCIAL_STATUSES.includes(
      cases[0].values.status as (typeof COMMERCIAL_STATUSES)[number],
    )
  )
    throw new InvalidProtectedData();
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !(COMMERCIAL_TABLES as readonly string[]).includes(row.table) ||
      ids.has(rowKey(row as CommercialFragment))
    )
      throw new InvalidProtectedData();
    ids.add(rowKey(row as CommercialFragment));
    for (const key of keys(row.table)) addressId(publicId(row.values[key]));
    if (row.table !== "commercial_cases" && publicId(row.values.case_id) !== id)
      throw new InvalidProtectedData();
    if (
      row.table === "commercial_documents" &&
      (typeof row.values.file_name !== "string" ||
        !row.values.file_name.trim() ||
        /[/\\\0]/.test(row.values.file_name) ||
        BigInt(row.values.version as string) < 1n ||
        (row.values.source_version !== null &&
          BigInt(row.values.source_version as string) < 1n))
    )
      throw new InvalidProtectedData();
  }
  addressText(cases[0].values.title, true, 127);
  const scope = JSON.parse(cases[0].values.scope_item_ids as string);
  if (
    !Array.isArray(scope) ||
    scope.length > 20000 ||
    scope.some(
      (value) =>
        typeof value !== "string" || !value.length || value.length > 200,
    ) ||
    new Set(scope).size !== scope.length
  )
    throw new InvalidProtectedData();
  if (
    rows.some((row) =>
      ["commercial_invoice_details", "commercial_invoice_payments"].includes(
        row.table,
      ),
    ) &&
    !isInvoice(cases[0].values.kind as string)
  )
    throw new InvalidProtectedData();
  if (
    rows.filter((row) => row.table === "commercial_invoice_details").length > 1
  )
    throw new InvalidProtectedData();
  return rows.sort((a, b) =>
    rowKey(a as CommercialFragment).localeCompare(
      rowKey(b as CommercialFragment),
    ),
  );
}
export function splitCommercialRows(
  id: string,
  inputs: unknown[],
): Map<CommercialFacet, CommercialPayload> {
  const rows = checkRows(id, inputs);
  const kind = rows.find((row) => row.table === "commercial_cases")!.values
    .kind as string;
  return new Map(
    COMMERCIAL_FACETS.map((facet) => [
      facet,
      {
        format: "sortsys-commercial-case-v1",
        schema: businessSchema.fingerprint,
        caseId: id,
        facet,
        rows: rows.flatMap((row) => {
          const names = columns(
            row.table,
            facet,
            kind,
            row.values.purpose as string | undefined,
          );
          return names.length
            ? [
                {
                  table: row.table as CommercialTable,
                  values: Object.fromEntries(
                    names.map((name) => [name, row.values[name]]),
                  ),
                },
              ]
            : [];
        }),
      },
    ]),
  );
}
export function commercialFacetPayload(
  input: unknown,
  id: string,
  facet: CommercialFacet,
): CommercialPayload {
  const source = record(input, ["format", "schema", "caseId", "facet", "rows"]);
  addressId(id);
  if (
    source.format !== "sortsys-commercial-case-v1" ||
    source.schema !== businessSchema.fingerprint ||
    source.caseId !== id ||
    source.facet !== facet ||
    !Array.isArray(source.rows) ||
    source.rows.length > 10000
  )
    throw new InvalidProtectedData();
  const seen = new Set<string>();
  const rows = source.rows
    .map((input) => {
      const row = record(input, ["table", "values"]);
      if (!(COMMERCIAL_TABLES as readonly unknown[]).includes(row.table))
        throw new InvalidProtectedData();
      const definition = tableDefinition(row.table as string);
      const inputValues = partialAddressRecord(
        row.values,
        definition.columns.map((column) => column.name),
      );
      record(inputValues, Object.keys(inputValues));
      const order = [
        ...keys(row.table as string),
        ...definition.columns
          .map((column) => column.name)
          .filter((name) => !keys(row.table as string).includes(name)),
      ];
      const values = Object.fromEntries(
        order
          .filter((name) => Object.hasOwn(inputValues, name))
          .map((name) => [name, inputValues[name]]),
      );
      for (const key of keys(row.table as string))
        addressId(publicId(values[key]));
      if (
        publicId(
          values[row.table === "commercial_cases" ? "id" : "case_id"],
        ) !== id
      )
        throw new InvalidProtectedData();
      // Each independently loaded fragment must already have a valid field
      // layout. Joining facets additionally checks the actual kind and purpose.
      if (
        !COMMERCIAL_KINDS.some((kind) => {
          const names = columns(row.table as string, facet, kind);
          return (
            names.length > 0 &&
            names.length === Object.keys(values).length &&
            names.every((name) => Object.hasOwn(values, name))
          );
        })
      )
        throw new InvalidProtectedData();
      decodeBusinessFields(row.table as string, values);
      const result = { table: row.table as CommercialTable, values };
      const key = rowKey(result);
      if (seen.has(key)) throw new InvalidProtectedData();
      seen.add(key);
      return result;
    })
    .sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  return {
    format: source.format,
    schema: source.schema as string,
    caseId: id,
    facet,
    rows,
  };
}

/** Missing private facets are represented only in this RAM projection. Their
 * placeholders are never persisted over the original facet or exported as XML. */
export function joinCommercialFacets(
  id: string,
  inputs: ReadonlyMap<CommercialFacet, unknown>,
): BusinessRow[] {
  const parts = new Map(
    [...inputs].map(([facet, input]) => [
      facet,
      commercialFacetPayload(input, id, facet),
    ]),
  );
  const master = parts.get("master-data");
  if (!master) throw new InvalidProtectedData();
  const primary = master.rows.find((row) => row.table === "commercial_cases");
  const kind = primary?.values.kind;
  if (
    typeof kind !== "string" ||
    !COMMERCIAL_KINDS.includes(kind as (typeof COMMERCIAL_KINDS)[number])
  )
    throw new InvalidProtectedData();
  const merged = new Map<string, CommercialFragment>();
  for (const row of master.rows) {
    if (
      ![
        "commercial_cases",
        "commercial_documents",
        "commercial_case_events",
      ].includes(row.table)
    )
      throw new InvalidProtectedData();
    const expected = columns(
      row.table,
      "master-data",
      kind,
      row.values.purpose as string | undefined,
    );
    record(row.values, expected);
    merged.set(rowKey(row), {
      table: row.table,
      values: {
        ...(row.table === "commercial_cases"
          ? { net_amount: null, notes: null, scope_item_ids: "[]" }
          : row.table === "commercial_documents"
            ? { net_amount: null, object_key: "" }
            : {}),
        ...row.values,
      },
    });
  }
  for (const [facet, part] of parts)
    if (facet !== "master-data")
      for (const row of part.rows) {
        const key = rowKey(row);
        const old = merged.get(key);
        const standalone = [
          "commercial_invoice_details",
          "commercial_invoice_payments",
        ].includes(row.table);
        if (!old && !standalone) throw new InvalidProtectedData();
        const names = columns(
          row.table,
          facet,
          kind,
          old?.values.purpose as string | undefined,
        );
        if (!names.length) throw new InvalidProtectedData();
        record(row.values, names);
        merged.set(key, {
          table: row.table,
          values: { ...old?.values, ...row.values },
        });
      }
  const rows = checkRows(
    id,
    [...merged.values()].map((row) => ({
      format: "sortsys-row-v2",
      schema: businessSchema.fingerprint,
      ...row,
    })),
  );
  const expected = splitCommercialRows(id, rows);
  for (const [facet, part] of parts)
    if (JSON.stringify(expected.get(facet)) !== JSON.stringify(part))
      throw new InvalidProtectedData();
  return rows;
}

export function wireCommercialCase(
  rows: BusinessRow[],
  labels: { customerName?: string | null; projectTitle?: string | null } = {},
): CommercialCase {
  const p = rows.find((row) => row.table === "commercial_cases")?.values;
  if (!p) throw new InvalidProtectedData();
  const id = (key: string) => (p[key] === null ? null : publicId(p[key]));
  return {
    id: publicId(p.id),
    reference: p.reference as string,
    kind: p.kind as CommercialCase["kind"],
    status: p.status as CommercialCase["status"],
    title: p.title as string,
    existingContract: p.existing_contract as boolean,
    projectId: id("project_id"),
    projectTitle: labels.projectTitle ?? null,
    parentCaseId: id("parent_case_id"),
    customerId: id("customer_id"),
    customerName: labels.customerName ?? null,
    counterpartyName: p.counterparty_name as string | null,
    currency: p.currency as string,
    netAmount: p.net_amount as string | null,
    validUntil: p.valid_until as string | null,
    notes: p.notes as string | null,
    scopeItemIds: JSON.parse(p.scope_item_ids as string),
    selectedOfferDocumentId: id("selected_offer_document_id"),
    acceptedAt: p.accepted_at as string | null,
    createdAt: p.created_at as string,
    modifiedAt: p.modified_at as string,
  };
}

export function commercialCents(input: unknown): bigint {
  if (
    typeof input !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input)
  )
    throw new InvalidProtectedData();
  const negative = input.startsWith("-");
  const [whole, fraction = ""] = input.replace(/^-/, "").split(".");
  return (
    (negative ? -1n : 1n) *
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")))
  );
}
export function commercialMoney(value: bigint): string {
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
export function wireCommercialInvoice(
  rows: BusinessRow[],
): QueryResult<"commercial.cases.get">["invoice"] {
  const p = rows.find(
    (row) => row.table === "commercial_invoice_details",
  )?.values;
  if (!p) return null;
  const payments = rows
    .filter((row) => row.table === "commercial_invoice_payments")
    .map((row) => ({
      id: publicId(row.values.id),
      amount: row.values.amount as string,
      paidOn: row.values.paid_on as string,
      reference: row.values.reference as string,
    }))
    .sort(
      (a, b) =>
        a.paidOn.localeCompare(b.paidOn) ||
        (BigInt(addressId(a.id)) < BigInt(addressId(b.id)) ? -1 : 1),
    );
  return {
    basis: p.basis as string,
    vatRate: p.vat_rate as string,
    invoiceNumber: p.invoice_number as string | null,
    invoiceDate: p.invoice_date as string,
    dueDate: p.due_date as string,
    serviceStart: p.service_start as string,
    serviceEnd: p.service_end as string,
    totalNet: p.total_net as string,
    deductedNet: p.deducted_net as string,
    grossAmount: p.gross_amount as string,
    paidAmount: commercialMoney(
      payments.reduce(
        (sum, payment) => sum + commercialCents(payment.amount),
        0n,
      ),
    ),
    payments,
  };
}

import {
  base64,
  bytes,
  immutableObject,
  immutablePrefix,
  InvalidProtectedData,
  record,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { calendarDay } from "./calendarDays";
import { INVOICE_LEDGER_COLLECTION } from "./organizationData";
import { defineDataModel } from "./runtime/model";
import type { Collection } from "./protectedObjects";

export const MAX_INVOICE_COUNTER = 9223372036854775807n;
export type InvoiceNumberNamespace = {
  format: "sortsys-invoice-namespace-v1";
  secret: string;
};
export type InvoiceCounter = {
  format: "sortsys-invoice-counter-v1";
  scope: string;
  nextNumber: string;
};
export type InvoiceNumberClaim = {
  format: "sortsys-invoice-number-v1";
  caseId: string;
  projectId: string;
  invoiceDate: string;
  number: string;
};

export function counterScope(input: unknown): string {
  if (input === "global") return input;
  if (typeof input !== "string" || !input.startsWith("project:"))
    throw new InvalidProtectedData();
  addressId(input.slice("project:".length));
  return input;
}

export function nextInvoiceNumber(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[1-9]\d{0,18}$/.test(input) ||
    BigInt(input) > MAX_INVOICE_COUNTER + 1n
  )
    throw new InvalidProtectedData();
  return input;
}

function boundArea(area: Collection) {
  if (
    area.domain !== INVOICE_LEDGER_COLLECTION.domain ||
    area.scope !== INVOICE_LEDGER_COLLECTION.scope ||
    area.facet !== "billing"
  )
    throw new InvalidProtectedData();
}

const namespaceObject = immutableObject(
  INVOICE_LEDGER_COLLECTION.scope,
  "billing",
  "invoice-namespace",
  "root",
);
export const INVOICE_NAMESPACE_MODEL = defineDataModel<InvoiceNumberNamespace>({
  name: "invoice-number-namespace",
  decode(input, object, area) {
    boundArea(area);
    const value = record(input, ["format", "secret"]);
    if (
      object !== namespaceObject ||
      value.format !== "sortsys-invoice-namespace-v1"
    )
      throw new InvalidProtectedData();
    sized(value.secret as string, 32);
    return value as InvoiceNumberNamespace;
  },
  sources: () => [],
  tables: [],
});
export const invoiceNamespaceRequest = {
  model: INVOICE_NAMESPACE_MODEL,
  area: { ...INVOICE_LEDGER_COLLECTION, prefix: namespaceObject },
  ids: [namespaceObject],
};

export const INVOICE_COUNTER_MODEL = defineDataModel<InvoiceCounter>({
  name: "invoice-counter",
  decode(input, object, area) {
    boundArea(area);
    const value = record(input, ["format", "scope", "nextNumber"]);
    const scope = counterScope(value.scope);
    if (
      value.format !== "sortsys-invoice-counter-v1" ||
      object !== invoiceCounterRequest(scope).area.prefix
    )
      throw new InvalidProtectedData();
    return {
      format: value.format,
      scope,
      nextNumber: nextInvoiceNumber(value.nextNumber),
    };
  },
  sources: () => [],
  tables: [],
});

export function invoiceCounterRequest(scope: string) {
  counterScope(scope);
  const object = `${INVOICE_LEDGER_COLLECTION.prefix}counter:${scope}`;
  return {
    model: INVOICE_COUNTER_MODEL,
    area: { ...INVOICE_LEDGER_COLLECTION, prefix: object },
    ids: [object],
  };
}

export const INVOICE_NUMBER_MODEL = defineDataModel<InvoiceNumberClaim>({
  name: "invoice-number-claim",
  decode(input, object, area) {
    boundArea(area);
    const value = record(input, [
      "format",
      "caseId",
      "projectId",
      "invoiceDate",
      "number",
    ]);
    const prefix = immutablePrefix(area.scope, "billing", "invoice-number");
    if (
      !object.startsWith(prefix) ||
      !/^[\w-]{43}$/.test(object.slice(prefix.length)) ||
      value.format !== "sortsys-invoice-number-v1"
    )
      throw new InvalidProtectedData();
    addressId(value.caseId);
    addressId(value.projectId);
    if (
      typeof value.number !== "string" ||
      !value.number ||
      value.number.length > 255 ||
      value.number.includes("\0")
    )
      throw new InvalidProtectedData();
    calendarDay(value.invoiceDate);
    return value as InvoiceNumberClaim;
  },
  sources: () => [],
  tables: [],
});

/** A stable secret survives key rotation and recovery. Published object names
 * reveal neither sequential invoice numbers nor the dates encoded in them. */
export async function invoiceNumberObject(
  namespace: InvoiceNumberNamespace,
  number: string,
): Promise<string> {
  const raw = sized(namespace.secret, 32);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bytes(number)),
    );
    return immutableObject(
      INVOICE_LEDGER_COLLECTION.scope,
      "billing",
      "invoice-number",
      base64(digest),
    );
  } finally {
    raw.fill(0);
  }
}

export function invoiceNumberRequest(object: string) {
  const prefix = immutablePrefix(
    INVOICE_LEDGER_COLLECTION.scope,
    "billing",
    "invoice-number",
  );
  if (
    !object.startsWith(prefix) ||
    !/^[\w-]{43}$/.test(object.slice(prefix.length))
  )
    throw new InvalidProtectedData();
  return {
    model: INVOICE_NUMBER_MODEL,
    area: { ...INVOICE_LEDGER_COLLECTION, prefix: object },
    ids: [object],
  };
}

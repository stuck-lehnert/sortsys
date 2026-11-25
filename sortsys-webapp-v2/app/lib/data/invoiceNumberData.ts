import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { calendarDay } from "./calendarDays";
import {
  defineNumberLedger,
  nextLedgerNumber,
} from "./numberLedger";
import { INVOICE_LEDGER_COLLECTION } from "./organizationData";

export type InvoiceNumberClaim = {
  format: "sortsys-invoice-number-v1";
  caseId: string;
  projectId: string;
  invoiceDate: string;
  number: string;
};

export const invoiceNumberLedger = defineNumberLedger<InvoiceNumberClaim>()({
  name: "invoice",
  area: INVOICE_LEDGER_COLLECTION,
  counterScope(input) {
    if (input === "global") return input;
    if (typeof input !== "string" || !input.startsWith("project:"))
      throw new InvalidProtectedData();
    addressId(input.slice("project:".length));
    return input;
  },
  decodeClaim(input) {
    const value = record(input, ["format", "caseId", "projectId", "invoiceDate", "number"]);
    if (value.format !== "sortsys-invoice-number-v1") throw new InvalidProtectedData();

    addressId(value.caseId);
    addressId(value.projectId);
    calendarDay(value.invoiceDate);

    if (
      typeof value.number !== "string" ||
      !value.number ||
      value.number.length > 255 ||
      value.number.includes("\0")
    ) throw new InvalidProtectedData();
    return value as InvoiceNumberClaim;
  },
});

export const invoiceCounterRequest = invoiceNumberLedger.counterRequest;
export const invoiceNumberRequest = invoiceNumberLedger.claimRequest;
export const invoiceNumberObject = invoiceNumberLedger.claimObject;
export const nextInvoiceNumber = nextLedgerNumber;

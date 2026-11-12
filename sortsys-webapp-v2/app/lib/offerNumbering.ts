import type { QueryResult } from "@sortsys/v2-client";
import { formatInvoiceNumber, previewInvoiceNumbers } from "./invoiceNumbering.ts";

export type OfferNumbering = QueryResult<"settings.offerNumbering.get">;
export type OfferNumberingScheme = OfferNumbering["scheme"];

// Offers are numbered on creation using the server's UTC calendar date.
function utcDate(date: Date): Date {
  if (!Number.isFinite(date.getTime())) throw new Error("invalid-offer-date");
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function formatOfferNumber(config: OfferNumbering, date: Date, counter?: string): string {
  return formatInvoiceNumber(config, { date: utcDate(date), globalCounter: counter });
}

export function previewOfferNumbers(config: OfferNumbering, date: Date): string[] {
  return previewInvoiceNumbers(config, { date: utcDate(date) });
}

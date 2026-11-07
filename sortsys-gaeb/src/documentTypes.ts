import type { GaebPhase } from "./core/types";
import type { GaebLocale } from "./messages";

export const GAEB_DOCUMENT_TYPES: Record<
  GaebPhase,
  { de: string; en: string; newDe: string; newEn: string }
> = {
  "80": {
    de: "Leistungskatalog",
    en: "Work catalogue",
    newDe: "Neuer Leistungskatalog",
    newEn: "New work catalogue",
  },
  "81": {
    de: "Leistungsbeschreibung",
    en: "Specification",
    newDe: "Neue Leistungsbeschreibung",
    newEn: "New specification",
  },
  "82": {
    de: "Kostenanschlag",
    en: "Cost estimate",
    newDe: "Neuer Kostenanschlag",
    newEn: "New cost estimate",
  },
  "85": {
    de: "Nebenangebot",
    en: "Alternative offer",
    newDe: "Neues Nebenangebot",
    newEn: "New alternative offer",
  },
  "52": {
    de: "Kalkulationsansätze",
    en: "Cost calculation",
    newDe: "Neue Kalkulation",
    newEn: "New cost calculation",
  },
  "89": {
    de: "Rechnung",
    en: "Invoice",
    newDe: "Neue Rechnung",
    newEn: "New invoice",
  },
  "93": {
    de: "Preisanfrage",
    en: "Price inquiry",
    newDe: "Neue Preisanfrage",
    newEn: "New price inquiry",
  },
  "94": {
    de: "Preisangebot",
    en: "Supplier quotation",
    newDe: "Neues Preisangebot",
    newEn: "New supplier quotation",
  },
  "96": {
    de: "Bestellung",
    en: "Purchase order",
    newDe: "Neue Bestellung",
    newEn: "New purchase order",
  },
  "97": {
    de: "Lieferantenbestätigung",
    en: "Supplier confirmation",
    newDe: "Neue Lieferantenbestätigung",
    newEn: "New supplier confirmation",
  },
  "83": {
    de: "Angebotsaufforderung",
    en: "Invitation to tender",
    newDe: "Neue Angebotsaufforderung",
    newEn: "New invitation to tender",
  },
  "84": { de: "Angebot", en: "Bid", newDe: "Neues Angebot", newEn: "New bid" },
  "86": {
    de: "Auftragserteilung",
    en: "Contract award",
    newDe: "Neue Auftragserteilung",
    newEn: "New contract award",
  },
  "87": {
    de: "Auftragsbestätigung",
    en: "Order confirmation",
    newDe: "Neue Auftragsbestätigung",
    newEn: "New order confirmation",
  },
  "31": {
    de: "Aufmaß",
    en: "Quantity takeoff",
    newDe: "Neues Aufmaß",
    newEn: "New quantity takeoff",
  },
};
export function gaebDocumentName(
  phase: GaebPhase,
  locale: GaebLocale,
  create = false,
): string {
  const labels = GAEB_DOCUMENT_TYPES[phase];
  return create
    ? locale === "en"
      ? labels.newEn
      : labels.newDe
    : labels[locale];
}

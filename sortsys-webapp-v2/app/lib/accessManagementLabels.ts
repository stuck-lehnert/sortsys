import type { ManagedArea } from "./crypto/managedAreas";
import { uiText } from "./i18n";

const fields: Record<string, () => string> = {
  catalogue: () => uiText("Produktkatalog", "Product catalogue"),
  customers: () => uiText("Kunden", "Customers"),
  contacts: () => uiText("Ansprechpartner", "Contacts"),
  vendors: () => uiText("Lieferanten", "Suppliers"),
  prices: () => uiText("Preisaufzeichnungen", "Price records"),
  tools: () => uiText("Werkzeugverzeichnis", "Tool directory"),
  "master-data": () => uiText("Grunddaten", "Master data"),
  scope: () => uiText("Leistungsumfang", "Work descriptions"),
  "contract-quantities": () => uiText("Vertragsmengen", "Contract quantities"),
  measurement: () => uiText("Aufmaß", "Measured work"),
  "offer-prices": () => uiText("Angebotspreise", "Offer prices"),
  calculation: () => uiText("Interne Kosten", "Internal costs"),
  procurement: () => uiText("Beschaffung und Kosten", "Procurement and costs"),
  billing: () => uiText("Rechnungswerte", "Invoice values"),
  attachment: () => uiText("Dateien", "Files"),
  personnel: () => uiText("Arbeitszeiten", "Work hours"),
  "organization:master-data": () =>
    uiText("Unternehmensanschrift", "Company address"),
  "organization:billing": () =>
    uiText("Rechnungsnummern-Schema", "Invoice number format"),
  "organization:invoicing:billing": () =>
    uiText("Rechnungsnummern", "Invoice numbers"),
  "organization:attachment": () =>
    uiText("Dokumentvorlagen", "Document templates"),
  "organization:calculation": () => uiText("Gemeinkosten", "Overhead rates"),
  "organization:scripts:master-data": () =>
    uiText("Client-Skripte", "Client scripts"),
};
const resources = {
  project: () => uiText("Projekt", "Project"),
  commercial: () => uiText("Dokument", "Document"),
  personnel: () => uiText("Person", "Person"),
  tool: () => uiText("Werkzeug", "Tool"),
  "tool-tracking": () => uiText("Werkzeugbuchung", "Tool booking"),
  absence: () => uiText("Abwesenheiten", "Absences"),
} as const;
const modules: Record<string, () => string> = {
  "delivery-notes": () => uiText("Lieferscheine", "Delivery notes"),
  "daily-reports": () => uiText("Bautagesberichte", "Daily reports"),
  "regie-reports": () => uiText("Regieberichte", "Time-and-material reports"),
  planning: () => uiText("Einsatzplanung", "Deployment planning"),
  "tool-usage": () => uiText("Werkzeugnutzung", "Tool usage"),
};

export function managedAreaLabel(descriptor: ManagedArea): string {
  const direct = fields[descriptor.key];
  if (descriptor.kind === "catalogue" || descriptor.kind === "organization")
    return direct ? direct() : descriptor.key;
  const [module, facet] = descriptor.key.split(":");
  const field = fields[facet ?? module!];
  const parts: string[] = [];
  const resource = resources[descriptor.kind];
  parts.push(`${resource()} ${descriptor.resourceId}`);
  if (facet && modules[module!]) parts.push(modules[module!]!());
  if (descriptor.kind === "personnel" && descriptor.key === "scope")
    parts.push(uiText("Personalangaben", "Employment details"));
  else if (descriptor.kind === "absence")
    parts.push(
      descriptor.key === "personnel"
        ? uiText("Entscheidungen", "Decisions")
        : uiText("Anträge", "Requests"),
    );
  else parts.push(field ? field() : descriptor.key);
  return parts.join(" – ");
}

import { gaebDocuments } from "~/lib/client";
import {
  COMMERCIAL_FACETS,
  commercialCollection,
  type CommercialFacet,
} from "~/lib/data/commercialAreas";
import { uiText } from "~/lib/i18n";
import {
  ResourceAccess,
  type ResourceAccessDefinition,
  type ResourceAccessProps,
} from "./ResourceAccess";

type Case = Awaited<ReturnType<typeof gaebDocuments.choices>>[number];
const labels: Record<CommercialFacet, () => string> = {
  "master-data": () => uiText("Bezeichnung und Status", "Title and status"),
  scope: () => uiText("Leistungsbeschreibungen", "Work descriptions"),
  "contract-quantities": () => uiText("Vertragsmengen", "Contract quantities"),
  measurement: () => uiText("Aufmaß", "Measured work"),
  "offer-prices": () => uiText("Angebotspreise", "Offer prices"),
  calculation: () => uiText("Interne Kalkulation", "Internal calculation"),
  procurement: () => uiText("Beschaffung", "Procurement"),
  billing: () => uiText("Rechnungswerte", "Invoice values"),
  attachment: () => uiText("Anlagen", "Attachments"),
};
const definition: ResourceAccessDefinition<Case> = {
  heading: () => uiText("Angebote und Dokumente", "Offers and documents"),
  resourceLabel: () => uiText("Angebot oder Dokument", "Offer or document"),
  saveLabel: () => uiText("Dokumentzugriff speichern", "Save document access"),
  reloadLabel: () =>
    uiText("Dokumentfreigaben laden", "Reload document access"),
  errorLabel: () =>
    uiText(
      "Die Dokumentfreigaben konnten nicht aktualisiert werden.",
      "Document access could not be updated.",
    ),
  async load(signal) {
    return gaebDocuments.choices(signal);
  },
  describe: (value) => `${value.reference} – ${value.title}`,
  fields: COMMERCIAL_FACETS.map((facet) => ({
    key: facet,
    label: labels[facet],
    area: (value) => commercialCollection(value.id, facet),
  })),
};
export function CommercialAccess(props: ResourceAccessProps) {
  return <ResourceAccess {...props} definition={definition} />;
}

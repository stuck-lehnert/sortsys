import type { QueryResult } from "@sortsys/v2-client";
import {
  GaebDocument,
  readGaebInput,
  deriveGaebDocument,
  gaebNetAmount,
  validateGaebInBrowser,
  type DerivationOptions,
  type GaebPhase,
} from "@sortsys/gaeb";
import { uiText, currentLocaleTag } from "./i18n";
import { client } from "./client";
export type CommercialCase = QueryResult<"commercial.cases.list">[number];
export type CommercialDetail = QueryResult<"commercial.cases.get">;
export type CommercialDocument = CommercialDetail["documents"][number];
export type CommercialKind = CommercialCase["kind"];
export const kindLabel = (kind: CommercialKind) =>
  ({
    offer: uiText("Angebot", "Offer"),
    alternative: uiText("Nebenangebot", "Alternative offer"),
    procurement: uiText("Preisanfrage", "Price inquiry"),
    calculation: uiText("Kalkulation", "Cost calculation"),
    invoice: uiText("Rechnung", "Invoice"),
    progress_invoice: uiText("Abschlagsrechnung", "Progress invoice"),
    final_invoice: uiText("Schlussrechnung", "Final invoice"),
    variation: uiText("Nachtragsangebot", "Variation offer"),
    subcontract: uiText("Weitervergabe", "Subcontract package"),
    measurement: uiText("Aufmaß", "Measured work"),
  })[kind];
export const statusLabel = (status: string) =>
  ({
    partially_paid: uiText("Teilbezahlt", "Partially paid"),
    paid: uiText("Bezahlt", "Paid"),
    draft: uiText("In Bearbeitung", "Draft"),
    sent: uiText("Abgegeben", "Submitted"),
    accepted: uiText("Angenommen", "Accepted"),
    rejected: uiText("Abgelehnt", "Declined"),
    cancelled: uiText("Zurückgezogen", "Withdrawn"),
    requested: uiText("Angefragt", "Requested"),
    awarded: uiText("Beauftragt", "Awarded"),
    confirmed: uiText("Bestätigt", "Confirmed"),
    submitted: uiText("Eingereicht", "Submitted"),
    approved: uiText("Freigegeben", "Approved"),
  })[status] ?? status;
export const purposeLabel = (
  doc: Pick<CommercialDocument, "purpose" | "readOnly" | "fileName">,
  kind: CommercialKind,
) =>
  ({
    inquiry:
      kind === "subcontract"
        ? uiText("Leistungsanfrage", "Work inquiry")
        : doc.readOnly
          ? uiText("Anfrage des Auftraggebers", "Customer inquiry")
          : uiText("Leistungsumfang", "Scope of work"),
    offer:
      kind === "subcontract"
        ? uiText("Nachunternehmerangebot", "Subcontractor offer")
        : kind === "variation"
          ? uiText("Nachtragsangebot", "Variation offer")
          : uiText("Angebot", "Offer"),
    order:
      kind === "subcontract"
        ? uiText("Beauftragung", "Subcontract order")
        : uiText("Auftrag des Kunden", "Customer order"),
    confirmation:
      kind === "subcontract"
        ? uiText(
            "Bestätigung des Nachunternehmers",
            "Subcontractor confirmation",
          )
        : uiText("Auftragsbestätigung", "Order confirmation"),
    measurement: uiText("Aufmaß", "Measured work"),
    alternative: uiText("Nebenangebot", "Alternative offer"),
    calculation: uiText("Kalkulation", "Cost calculation"),
    invoice: kindLabel(kind),
    price_inquiry: uiText("Preisanfrage", "Price inquiry"),
    supplier_offer: uiText("Lieferantenangebot", "Supplier quote"),
    purchase_order: uiText("Bestellung", "Purchase order"),
    supplier_confirmation: uiText(
      "Lieferantenbestätigung",
      "Supplier confirmation",
    ),
  })[doc.purpose] ?? doc.fileName;
export const money = (
  amount: string | null | undefined,
  currency = "EUR",
  unitPrice = false,
) =>
  amount == null
    ? "—"
    : new Intl.NumberFormat(currentLocaleTag(), {
        style: "currency",
        currency,
        maximumFractionDigits: unitPrice ? 3 : 2,
      }).format(Number(amount));
export function commercialError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known: Array<[string, string]> = [
    [
      "legacy-gaeb-structure",
      uiText(
        "Die ältere GAEB-Datei enthält eine unvollständige oder nicht unterstützte Struktur.",
        "The legacy GAEB file contains an incomplete or unsupported structure.",
      ),
    ],
    [
      "legacy-gaeb-pricing",
      uiText(
        "Diese ältere Datei enthält besondere Positionsarten, die noch nicht sicher übernommen werden können.",
        "This legacy file contains special item types that cannot yet be converted reliably.",
      ),
    ],
    [
      "invoice addresses",
      uiText(
        "Bitte Absender- und Empfängeranschrift vollständig ausfüllen.",
        "Complete both invoice addresses.",
      ),
    ],
    [
      "tax number",
      uiText(
        "Bitte die Steuernummer im Rechnungsdokument angeben.",
        "Enter the tax number in the invoice.",
      ),
    ],
    [
      "progress invoices changed",
      uiText(
        "Die Abschläge wurden geändert. Bitte die Schlussrechnung aus dem aktuellen Auftrag neu erstellen.",
        "Progress invoices changed. Recreate the final invoice from the current contract.",
      ),
    ],
    [
      "outstanding amount",
      uiText(
        "Der Betrag überschreitet den offenen Rechnungsbetrag.",
        "The amount exceeds the outstanding balance.",
      ),
    ],
    [
      "billing-exceeds-total",
      uiText(
        "Die Abschläge übersteigen den abgerechneten Leistungswert.",
        "Progress invoices exceed the billed work value.",
      ),
    ],

    [
      "checked net amount",
      uiText(
        "Für die Abgabe wird eine gültig geprüfte Angebotskalkulation benötigt.",
        "Submission requires a validated offer calculation.",
      ),
    ],
    [
      "immutable source",
      uiText(
        "Dieser Dokumentstand ist festgeschrieben. Öffne den aktuellen Vorgang für den nächsten Bearbeitungsschritt.",
        "This document revision is fixed. Open the workflow for the next step.",
      ),
    ],
    [
      "workflow-missing-prices",
      uiText(
        "Im Nachunternehmerangebot fehlen Positionen. Lass ein vollständiges oder ausdrücklich als nicht angeboten gekennzeichnetes Angebot bereitstellen.",
        "The subcontractor offer has missing items. Obtain a complete offer or items explicitly marked as not offered.",
      ),
    ],
    [
      "workflow-quantity-difference",
      uiText(
        "Die Mengen im Nachunternehmerangebot weichen von der Anfrage ab. Kläre die Mengen und öffne das korrigierte Angebot.",
        "The subcontractor's quantities differ from the inquiry. Resolve them and open the corrected offer.",
      ),
    ],
    [
      "workflow-address-length",
      uiText(
        "Die Organisationsadresse überschreitet die GAEB-Feldlängen (40 Zeichen für Straße/Ort, 20 für PLZ). Bitte unter Verwaltung → Organisation anpassen.",
        "The organization address exceeds GAEB field limits (40 characters for street/city, 20 for postal code). Update it in Administration → Organization.",
      ),
    ],
    [
      "workflow-currency",
      uiText(
        "Diese Projektabläufe unterstützen derzeit EUR. Die Datei wurde nicht verändert.",
        "These contract workflows currently support EUR. The file was not changed.",
      ),
    ],
    [
      "Expected X",
      uiText(
        "Die Datei hat nicht den für diesen Schritt benötigten Dokumenttyp. Prüfe die GAEB-Phase.",
        "This file does not have the document type needed for this step. Check its GAEB phase.",
      ),
    ],
    [
      "subcontractor's company",
      uiText(
        "Bitte den Namen des Nachunternehmers angeben.",
        "Enter the subcontractor's company name.",
      ),
    ],
    [
      "main contract",
      uiText(
        "Dieses Projekt hat bereits einen Hauptauftrag.",
        "This project already has a main contract.",
      ),
    ],
    [
      "customer",
      uiText("Bitte zuerst einen Kunden zuordnen.", "Assign a customer first."),
    ],
    [
      "current workflow step",
      uiText(
        "Dieses Dokument passt nicht zum aktuellen Bearbeitungsschritt. Aktualisiere den Vorgang.",
        "This document does not fit the current workflow step. Refresh the workflow.",
      ),
    ],
    [
      "calculation from",
      uiText(
        "Der Leistungsumfang wurde geändert. Bitte die Kalkulation aktualisieren.",
        "The scope changed. Update the calculation first.",
      ),
    ],
    [
      "another session",
      uiText(
        "Der Vorgang wurde zwischenzeitlich geändert. Bitte aktualisieren.",
        "The workflow changed in another session. Please refresh.",
      ),
    ],
    [
      "source document changed",
      uiText(
        "Das Ausgangsdokument wurde geändert. Bitte erneut öffnen.",
        "The source document changed. Please reopen it.",
      ),
    ],
    [
      "main offer",
      uiText(
        "Ein neues Hauptangebot wird vor einem neuen Projekt erstellt.",
        "Create a new main offer before starting a new project.",
      ),
    ],
    [
      "already subcontracted",
      uiText(
        "Mindestens eine Position ist bereits weitervergeben.",
        "At least one position has already been subcontracted.",
      ),
    ],
    [
      "workflow-reference-required",
      uiText(
        "Zu dieser Preisdatei wird das zugehörige Leistungsverzeichnis benötigt.",
        "This price file requires its associated bill of quantities.",
      ),
    ],
    [
      "workflow-pricing-rules",
      uiText(
        "Die besonderen Preisregeln dieses Leistungsverzeichnisses werden beim Ableiten noch nicht unterstützt. Die Originaldatei bleibt erhalten.",
        "Derivation does not yet support this bill's special pricing rules. The original file is retained.",
      ),
    ],
    [
      "workflow-scope-required",
      uiText(
        "Wähle mindestens eine Position für den Leistungsumfang.",
        "Select at least one item for the scope of work.",
      ),
    ],
    [
      "schema",
      uiText(
        "Die Datei ist nicht schemakonform. Prüfe die Datei vor dem nächsten Schritt.",
        "The file does not pass schema validation. Check it before continuing.",
      ),
    ],
  ];
  const match = known.find(([needle]) =>
    message.toLowerCase().includes(needle.toLowerCase()),
  );
  return match
    ? match[1]
    : uiText(
        "Der Vorgang konnte nicht abgeschlossen werden. Deine Eingaben bleiben erhalten. Bitte erneut versuchen.",
        "The action could not be completed. Your input is retained. Please try again.",
      );
}
export async function readGaebFile(file: File, phase?: GaebPhase) {
  if (file.size > 20 * 1024 * 1024) throw new Error("document-too-large");
  const input = readGaebInput(
    new Uint8Array(await file.arrayBuffer()),
    file.name,
  );
  const { xml } = input;
  const model = new GaebDocument(xml, input.fileName);
  if (phase && model.phase !== phase) throw new Error(`Expected X${phase}`);
  if (model.currency !== "EUR") throw new Error("workflow-currency");
  const checked = await validateGaebInBrowser(xml, model.identity);
  if (!checked.valid) throw new Error("schema");
  return { xml, model, fileName: input.fileName };
}
export async function deriveChecked(
  xml: string,
  phase: GaebPhase,
  options: DerivationOptions = {},
) {
  const result = deriveGaebDocument(xml, phase, options),
    model = new GaebDocument(result, `document.x${phase}`);
  const check = await validateGaebInBrowser(result, model.identity);
  if (!check.valid)
    throw new Error(`schema: ${check.issues[0]?.message ?? ""}`);
  return result;
}
export async function storeCommercialDocument(
  input: Parameters<typeof client.mutate<"commercial.documents.create">>[1],
) {
  const [value, error] = await client.mutate(
    "commercial.documents.create",
    input,
  );
  if (error || !value) throw error ?? new Error("create-failed");
  // Document mutations also change the case's document list and totals. Clear
  // completed/in-flight case queries before the caller opens the new document.
  await Promise.all([
    client.invalidate("commercial.cases.get"),
    client.invalidate("commercial.cases.list"),
  ]);
  return value;
}
export async function loadCommercialDocument(caseId: string, id: string) {
  const [value, error] = await client.query(
    "commercial.documents.get",
    { caseId, id },
    { strategy: "network-only" },
  );
  if (error || !value) throw error ?? new Error("load-failed");
  return value;
}
export const documentAmount = gaebNetAmount;
export const editableDocument = (
  item: CommercialCase,
  doc: CommercialDocument,
) =>
  !doc.readOnly &&
  (doc.purpose === "confirmation"
    ? ["accepted", "awarded"].includes(item.status)
    : doc.purpose === "order" || doc.purpose === "purchase_order"
      ? ["requested", "accepted"].includes(item.status)
      : item.status === "draft") &&
  !(doc.purpose === "offer" && doc.sourceVersion !== doc.sourceCurrentVersion);

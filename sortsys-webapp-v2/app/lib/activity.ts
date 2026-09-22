import type { QueryResult } from "@sortsys/v2-client";
import { uiText } from "./i18n";

export type ActivityItem = QueryResult<"personalization.activity.list">[number];

type FieldLabel = () => string;

// These are persisted column names, not RPC input names. A table can override
// a shared label where the same column has a different meaning.
const FIELD_LABELS: Record<string, FieldLabel> = {
  title: () => uiText("Titel", "Title"),
  name: () => uiText("Name", "Name"),
  address: () => uiText("Anschrift", "Address"),
  salutation: () => uiText("Anrede", "Salutation"),
  first_name: () => uiText("Vorname", "First name"),
  last_name: () => uiText("Nachname", "Last name"),
  username: () => uiText("Benutzername", "Username"),
  email: () => uiText("E-Mail-Adresse", "Email address"),
  phone: () => uiText("Telefonnummer", "Phone number"),
  email_addresses: () => uiText("E-Mail-Adressen", "Email addresses"),
  phone_numbers: () => uiText("Telefonnummern", "Phone numbers"),
  brand: () => uiText("Marke", "Brand"),
  status: () => uiText("Status", "Status"),
  category: () => uiText("Kategorie", "Category"),
  label: () => uiText("Bezeichnung", "Label"),
  description: () => uiText("Beschreibung", "Description"),
  comment: () => uiText("Kommentar", "Comment"),
  note: () => uiText("Notiz", "Note"),
  content: () => uiText("Inhalt", "Content"),
  text: () => uiText("Text", "Text"),
  body: () => uiText("Notiztext", "Note text"),
  type: () => uiText("Art", "Type"),
  custom_id: () => uiText("Nummer", "Number"),
  customer_id: () => uiText("Kunde", "Customer"),
  contact_id: () => uiText("Kontakt", "Contact"),
  project_id: () => uiText("Projekt", "Project"),
  product_id: () => uiText("Produkt", "Product"),
  tool_id: () => uiText("Werkzeug", "Tool"),
  vendor_id: () => uiText("Händler", "Vendor"),
  user_id: () => uiText("Benutzer", "User"),
  responsible_user_id: () => uiText("Verantwortlicher", "Responsible user"),
  responsible_project_leader_user_id: () => uiText("Verantwortlicher Projektleiter", "Responsible project leader"),
  supervisor_user_id: () => uiText("Vorgesetzter", "Supervisor"),
  order_received_at: () => uiText("Auftragseingang", "Order received"),
  finished_at: () => uiText("Projektabschluss", "Project completion"),
  from: () => uiText("Beginn", "Start"),
  to: () => uiText("Ende", "End"),
  day: () => uiText("Datum", "Date"),
  timestamp: () => uiText("Datum", "Date"),
  effective_timestamp: () => uiText("Datum", "Date"),
  started_at: () => uiText("Beginn", "Start"),
  ended_at: () => uiText("Ende", "End"),
  started_by_user_id: () => uiText("Gebucht durch", "Booked by"),
  ended_by_user_id: () => uiText("Zurückgegeben durch", "Returned by"),
  deadline_at: () => uiText("Rückgabefrist", "Return deadline"),
  quantity: () => uiText("Menge", "Quantity"),
  amount: () => uiText("Betrag", "Amount"),
  unit: () => uiText("Einheit", "Unit"),
  base_unit: () => uiText("Basiseinheit", "Base unit"),
  other_units: () => uiText("Weitere Einheiten", "Other units"),
  price: () => uiText("Preis", "Price"),
  price_per_unit: () => uiText("Einzelpreis", "Unit price"),
  purchase_price: () => uiText("Kaufpreis", "Purchase price"),
  usage_cost_per_day: () => uiText("Tageskosten", "Daily cost"),
  tool_usage_cost_per_day: () => uiText("Tageskosten", "Daily cost"),
  cost_per_hour: () => uiText("Stundensatz", "Hourly cost"),
  contract_type: () => uiText("Beschäftigungsart", "Employment type"),
  vacation_days_per_year: () => uiText("Urlaubsanspruch", "Leave allowance"),
  absence_type: () => uiText("Abwesenheitstyp", "Absence type"),
  password: () => uiText("Passwort", "Password"),
  password_hash: () => uiText("Passwort", "Password"),
  totp_uri: () => uiText("Zwei-Faktor-Anmeldung", "Two-factor authentication"),
  deactivated_at: () => uiText("Kontostatus", "Account status"),
  archived_at: () => uiText("Archivierung", "Archiving"),
  archived_since: () => uiText("Archivierung", "Archiving"),
  ui_locale: () => uiText("Sprache", "Language"),
  role_name: () => uiText("Berechtigung", "Permission"),
  denial_reason: () => uiText("Ablehnungsgrund", "Rejection reason"),
  decided_at: () => uiText("Entscheidungsdatum", "Decision date"),
  decided_by_user_id: () => uiText("Entscheidender Benutzer", "Deciding user"),
  requested_by_user_id: () => uiText("Antragsteller", "Requester"),
  summary: () => uiText("Berichtstext", "Report text"),
  weather: () => uiText("Wetter", "Weather"),
  hours: () => uiText("Stunden", "Hours"),
  is_real_purchase: () => uiText("Einkauf", "Purchase"),
  file_name: () => uiText("Dateiname", "File name"),
  mime_type: () => uiText("Dateityp", "File type"),
  folder_id: () => uiText("Ordner", "Folder"),
  parent_folder_id: () => uiText("Übergeordneter Ordner", "Parent folder"),
  object_key: () => uiText("Dateiinhalt", "File contents"),
  size_bytes: () => uiText("Dateiinhalt", "File contents"),
  etag: () => uiText("Dateiinhalt", "File contents"),
  office_version: () => uiText("Dateiinhalt", "File contents"),
  office_modified_at: () => uiText("Dateiinhalt", "File contents"),
  office_modified_by_user_id: () => uiText("Dateiinhalt", "File contents"),
  uploaded_at: () => uiText("Upload", "Upload"),
  thumbnail_status: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_object_key: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_mime_type: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_width: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_height: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_size_bytes: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_etag: () => uiText("Vorschaubild", "Thumbnail"),
  thumbnail_generated_at: () => uiText("Vorschaubild", "Thumbnail"),
  extracted_text: () => uiText("Dokumenttext", "Document text"),
  text_extraction_status: () => uiText("Texterkennung", "Text recognition"),
  text_extraction_method: () => uiText("Texterkennung", "Text recognition"),
  text_extraction_confidence: () => uiText("Texterkennung", "Text recognition"),
  text_extraction_page_count: () => uiText("Texterkennung", "Text recognition"),
  text_extraction_error: () => uiText("Texterkennung", "Text recognition"),
  text_extraction_version: () => uiText("Texterkennung", "Text recognition"),
  text_extracted_at: () => uiText("Texterkennung", "Text recognition"),
  reason: () => uiText("Grund", "Reason"),
  transfer_to_user_id: () => uiText("Empfänger", "Recipient"),
  continuation_of: () => uiText("Vorherige Buchung", "Previous booking"),
  tool_tracking_id: () => uiText("Werkzeugbuchung", "Tool booking"),
  notes: () => uiText("Notizen", "Notes"),
  public_key: () => uiText("Passkey", "Passkey"),
  public_key_jwk: () => uiText("Passkey", "Passkey"),
  sign_count: () => uiText("Passkey-Nutzung", "Passkey usage"),
  last_used_at: () => uiText("Letzte Nutzung", "Last used"),
  transports: () => uiText("Passkey-Verbindung", "Passkey transport"),
  credential_id: () => uiText("Passkey", "Passkey"),
  counter: () => uiText("Passkey-Nutzung", "Passkey usage"),
};

const TABLE_FIELD_LABELS: Record<string, Record<string, FieldLabel>> = {
  tools: { label: () => uiText("Modell", "Model") },
  project_contacts: { label: () => uiText("Funktion", "Role") },
  product_delivery_special_records: { amount: () => uiText("Menge", "Quantity") },
  regie_report_special_records: { amount: () => uiText("Menge", "Quantity") },
  project_user_assignments: { type: () => uiText("Projektrolle", "Project role") },
  project_files: { kind: () => uiText("Dateiart", "File kind"), status: () => uiText("Uploadstatus", "Upload status") },
  user_vacations: { status: () => uiText("Genehmigungsstatus", "Approval status") },
};

const FIELD_ORDER = new Map(Object.keys(FIELD_LABELS).map((column, index) => [column, index]));

export function activityChangedFieldLabels(item: ActivityItem) {
  const labels: string[] = [];
  const columns = [...item.changedColumns].sort((left, right) =>
    (FIELD_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) - (FIELD_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER));

  for (const column of columns) {
    // Ignore bookkeeping, but retain business dates (e.g. order receipt).
    if (column.startsWith("_") || ["id", "created_at", "modified_at", "updated_at", "created_by_user_id", "search_vector"].includes(column)) continue;
    if ((item.action === "completed" || item.action === "resumed") && column === "finished_at") continue;

    const label = TABLE_FIELD_LABELS[item.entityTable]?.[column] ?? FIELD_LABELS[column]
      ?? (() => uiText("Weitere Felder", "Other fields"));
    const translated = label();
    if (!labels.includes(translated)) labels.push(translated);
  }

  return labels;
}

function changedFieldsLabel(item: ActivityItem) {
  const labels = activityChangedFieldLabels(item);
  if (!labels.length) return null;
  if (labels.length === 1) return labels[0];
  return labels.slice(0, -1).join(", ") + uiText(" und ", " and ") + labels.at(-1);
}

export function activityTitle(item: ActivityItem) {
  const labels: Record<ActivityItem["resourceType"], string> = {
    project: uiText("Projekt", "Project"),
    tool: uiText("Werkzeug", "Tool"),
    user: uiText("Benutzer", "User"),
    customer: uiText("Kunde", "Customer"),
    contact: uiText("Kontakt", "Contact"),
    product: uiText("Produkt", "Product"),
    productVendor: uiText("Händler", "Vendor"),
    deliveryNote: uiText("Lieferschein", "Delivery note"),
    regieReport: uiText("Regiebericht", "Regie report"),
    dailyProjectReport: uiText("Bautagesbericht", "Daily project report"),
  };

  if (item.title && item.title !== item.entityTable) return item.title;
  return item.resourceTitle || labels[item.resourceType];
}

export function activityActorLabel(item: ActivityItem) {
  if (item.actorName) return item.actorName;
  if (item.actorUserId) return uiText("Unbekannter Benutzer", "Unknown user");
  if (item.actorKind === "globalAdmin") return uiText("Globaler Admin", "Global admin");
  if (item.actorKind === "tenantAdmin") return uiText("Mandanten-Admin", "Tenant admin");
  if (item.actorKind === "seed") return uiText("Beispieldaten", "Sample data");
  return item.isImported ? uiText("Nicht erfasst", "Not recorded") : uiText("System", "System");
}

export function activityActionLabel(item: ActivityItem) {
  const action = item.action;
  const fields = changedFieldsLabel(item);

  if (action === "completed" || action === "resumed") {
    const transition = action === "completed"
      ? uiText("Projekt abgeschlossen", "Project completed")
      : uiText("Projekt fortgesetzt", "Project resumed");
    return fields ? transition + uiText(`; ${fields} geändert`, `; ${fields} changed`) : transition;
  }

  if (item.entityTable === "user_role_assignments") {
    if (action === "created") return uiText("Berechtigung erteilt", "Permission granted");
    if (action === "deleted") return uiText("Berechtigung entzogen", "Permission revoked");
    return fields ? uiText(`${fields} geändert`, `${fields} changed`)
      : uiText("Berechtigung geändert", "Permission changed");
  }

  if (item.entityTable === "tool_trackings") {
    if (action === "created") return uiText("Werkzeug gebucht", "Tool booked");
    if (action === "updated" && item.changedColumns.includes("ended_at")) {
      const otherFields = changedFieldsLabel({
        ...item,
        changedColumns: item.changedColumns.filter(column =>
          column !== "ended_at" && column !== "ended_by_user_id"),
      });
      const returned = uiText("Werkzeug zurückgegeben", "Tool returned");
      return otherFields
        ? returned + uiText(`; ${otherFields} geändert`, `; ${otherFields} changed`)
        : returned;
    }
  }

  // Related records are changes to a subarea, not another creation of its owner.
  const subjects: Record<string, string> = {
    user_vacations: uiText("Abwesenheit", "Absence"),
    user_passkeys: uiText("Passkey", "Passkey"),
    resource_notes: uiText("Notiz", "Note"),
    project_files: uiText("Datei", "File"),
    project_file_folders: uiText("Ordner", "Folder"),
    project_user_assignments: uiText("Projektzuordnung", "Project assignment"),
    project_deployments: uiText("Einsatz", "Deployment"),
    project_unavailability_periods: uiText("Sperrzeit", "Blocked period"),
    project_financial_entries: uiText("Finanzeintrag", "Financial entry"),
    customer_contacts: uiText("Kontaktzuordnung", "Contact assignment"),
    project_contacts: uiText("Kontaktzuordnung", "Contact assignment"),
    product_price_records: uiText("Preis", "Price"),
    product_categories: uiText("Kategorie", "Category"),
    tool_trackings: uiText("Werkzeugbuchung", "Tool booking"),
    tool_inventories: uiText("Inventur", "Inventory"),
    tool_tracking_transfer_requests: uiText("Übergabe", "Transfer"),
    product_delivery_records: uiText("Position", "Line item"),
    product_delivery_special_records: uiText("Sonderposition", "Special line item"),
    regie_report_products: uiText("Materialposition", "Material line item"),
    regie_report_special_records: uiText("Sonderposition", "Special line item"),
    regie_report_work_hours: uiText("Arbeitszeit", "Work hours"),
    daily_project_report_work_hours: uiText("Arbeitszeit", "Work hours"),
    daily_project_report_files: uiText("Fotozuordnung", "Photo assignment"),
  };
  const subject = subjects[item.entityTable];

  if (subject) {
    if (action === "created") return uiText(`${subject} hinzugefügt`, `${subject} added`);
    if (action === "deleted") return uiText(`${subject} entfernt`, `${subject} removed`);
    return fields
      ? uiText(`${subject}: ${fields} geändert`, `${subject}: ${fields} changed`)
      : uiText(`${subject} geändert`, `${subject} changed`);
  }

  if (action === "deleted") return uiText("Gelöscht", "Deleted");
  if (action === "updated" && fields) return uiText(`${fields} geändert`, `${fields} changed`);
  return action === "updated" ? uiText("Geändert", "Changed") : uiText("Erstellt", "Created");
}

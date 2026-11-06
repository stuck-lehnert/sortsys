export type GaebLocale = "de" | "en";
export function text(
  locale: GaebLocale,
  german: string,
  english: string,
): string {
  return locale === "en" ? english : german;
}

export function errorText(locale: GaebLocale, error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, [string, string]> = {
    "hierarchy-mixed": [
      "Ein GAEB-Titel enthält entweder Positionen oder Untertitel. Wähle einen anderen Zielordner; es werden keine zusätzlichen Gruppen angelegt.",
      "A GAEB section contains either items or subsections. Choose another destination; no extra groups will be created.",
    ],
    "hierarchy-cycle": [
      "Ein Titel kann nicht in sich selbst oder einen seiner Untertitel verschoben werden.",
      "A section cannot be moved into itself or one of its subsections.",
    ],
    "hierarchy-numbering": [
      "Die importierte alphanumerische Gliederung oder Positionsindizes erfordern eine eigene Nummerierung. Die vorhandenen Nummern bleiben erhalten.",
      "Imported alphanumeric numbering or item indices need their own numbering rules. Existing numbers are retained.",
    ],
    "hierarchy-stale": [
      "Das Dokument wurde inzwischen geändert. Prüfe die aktualisierte Vorschau und übernimm die Änderung erneut.",
      "The document changed in the meantime. Review the refreshed preview and apply the change again.",
    ],
    "unit-too-long": [
      "Die Einheit darf höchstens vier Zeichen enthalten, zum Beispiel „Stk“, „m²“ oder „psch“. Bitte die Einheit kürzen; deine Eingabe bleibt erhalten.",
      "Units may contain up to four characters, for example ‘pcs’, ‘m²’ or ‘psch’. Shorten the unit; your input is retained.",
    ],
    "invalid-field": [
      "Dieses Feld kann in der aktuellen Dokumentphase nicht geändert werden. Deine Eingabe bleibt erhalten.",
      "This field cannot be changed in the current document phase. Your input is retained.",
    ],
    "autosave-invalid": [
      "Automatisches Speichern wartet auf die Korrektur der Prüfmeldungen. Deine Änderungen bleiben hier erhalten.",
      "Autosave is waiting for the validation issues to be resolved. Your changes are retained here.",
    ],
    "merge-conflict": [
      "An derselben Stelle wurde gleichzeitig etwas anderes eingetragen. Dein Arbeitsstand bleibt erhalten. Sichere eine Kopie und öffne den aktuellen Stand erneut, um die Änderung abzustimmen.",
      "Conflicting changes were made at the same location. Your work is retained. Download a copy and reopen the current version to resolve the change.",
    ],
    "document-complexity": [
      "Die Datei enthält zu viele oder zu tief verschachtelte Elemente.",
      "The file contains too many or excessively nested elements.",
    ],
    "rich-structure": [
      "Diese Textstruktur kann an dieser Stelle nicht geändert werden. Der ursprüngliche Inhalt bleibt erhalten.",
      "This text structure cannot be changed at this location. The original content is preserved.",
    ],
    "document-too-large": [
      "Die Datei überschreitet 20 MB.",
      "The file exceeds 20 MB.",
    ],
    "document-dtd": [
      "GAEB-Dateien mit DTD-Definitionen können nicht geöffnet werden.",
      "GAEB files with DTD declarations cannot be opened.",
    ],
    "document-encoding": [
      "Die Datei muss als UTF-8 gespeichert sein.",
      "The file must use UTF-8 encoding.",
    ],
    "not-gaeb": [
      "Diese XML-Datei ist kein GAEB-Dokument.",
      "This XML file is not a GAEB document.",
    ],
    "invalid-xml": [
      "Die XML-Struktur ist fehlerhaft.",
      "The XML structure is invalid.",
    ],
    "phase-conflict": [
      "Die Austauschphase im Header widerspricht dem Namensraum.",
      "The phase in the header conflicts with the namespace.",
    ],
    "unsupported-phase": [
      "Unterstützt werden X83, X84, X86, X87 und X31.",
      "Supported formats are X83, X84, X86, X87 and X31.",
    ],
    "unsupported-version": [
      "Unterstützt werden GAEB XML 3.1, 3.2 und 3.3.",
      "GAEB XML 3.1, 3.2 and 3.3 are supported.",
    ],
    "invalid-decimal": [
      "Bitte eine Dezimalzahl eingeben, zum Beispiel 12,500.",
      "Enter a decimal number, for example 12.500.",
    ],
    "decimal-precision": [
      "Die Zahl hat zu viele Stellen für dieses GAEB-Feld.",
      "The number has too many digits for this GAEB field.",
    ],
    "complex-pricing": [
      "Die besonderen Preisregeln dieser Datei erfordern eine manuelle Kalkulation. Preise und Summen bleiben erhalten.",
      "This file's special pricing rules require manual calculation. Prices and totals are preserved.",
    ],
    "invalid-document-title": ["Bitte eine Bezeichnung mit höchstens 127 Zeichen eingeben.","Enter a document title with at most 127 characters."],
    "project-name-too-long": ["Die Bauvorhaben-Bezeichnung darf im GAEB-Feld höchstens 60 Zeichen enthalten.","The GAEB project name may contain at most 60 characters."],
    "takeoff-expression": [
      "Bitte eine Zahl oder eine Formel eingeben, zum Beispiel 2,4 × 3 oder (1,2 + 0,8) × 2.",
      "Enter a number or formula, for example 2.4 × 3 or (1.2 + 0.8) × 2.",
    ],
    "takeoff-division-zero": [
      "In der Aufmaßformel wird durch null geteilt.",
      "The measurement formula divides by zero.",
    ],
    "takeoff-negative-dimension": [
      "Maße und Anzahl müssen positiv sein. Für Abzüge den Ansatz auf „Abzug“ stellen.",
      "Dimensions and count must be positive. Choose ‘Deduction’ for deductions.",
    ],
    "takeoff-opening-area": [
      "Öffnungsabzüge benötigen eine Flächenberechnung.",
      "Opening deductions require an area calculation.",
    ],
    "takeoff-external-change": [
      "Die gespeicherte Aufmaßmenge und die Maßansätze weichen ab. Die vorhandenen Angaben bleiben erhalten; die Abweichung muss zuerst geklärt werden.",
      "The stored measured quantity differs from its measurements. Existing data is retained; resolve this difference before editing.",
    ],
    "takeoff-reb-capacity": [
      "Der Ansatz überschreitet die verfügbare REB-Zeilenlänge. Bitte in mehrere Maßansätze aufteilen.",
      "The measurement exceeds the available REB row length. Split it into multiple measurements.",
    ],
    "invalid-reb-row": [
      "Eine REB-Zeile hat genau 80 Zeichen; die ersten elf Stellen bleiben leer.",
      "A REB row has exactly 80 characters; the first eleven must be blank.",
    ],
    "select-leaf-category": [
      "Wähle einen Bereich ohne Unterbereiche für die neue Position.",
      "Select a section without subsections for the new item.",
    ],
    "select-category": [
      "Wähle zuerst einen Titel für den neuen Untertitel.",
      "Select a section for the new subsection first.",
    ],
    "hierarchy-layout": [
      "Die vorhandene OZ-Gliederung lässt sich hier nicht sicher erweitern. Der Dokumentstand bleibt erhalten.",
      "The existing item numbering cannot safely be extended here. The document is retained.",
    ],
    "hierarchy-limit": [
      "Die verfügbare Stellenzahl der OZ-Gliederung ist ausgeschöpft.",
      "The item numbering has reached its available digit or level limit.",
    ],
    "hierarchy-reference": [
      "Diese Datei enthält Verweise auf Positionsnummern. Ihre Gliederung kann hier nicht umnummeriert werden; die vorhandenen Verweise bleiben erhalten.",
      "This file contains item-number references. Its structure cannot be renumbered here; existing references are retained.",
    ],
    "schema-unavailable": [
      "Für diese Ausgabe ist kein passendes Schema hinterlegt.",
      "No matching schema is available for this edition.",
    ],
    "attachment-too-large": [
      "Anlagen dürfen höchstens 10 MB groß sein; die gesamte GAEB-Datei höchstens 20 MB.",
      "Attachments may be up to 10 MB; the complete GAEB file up to 20 MB.",
    ],
    "duplicate-attachment": [
      "Eine Anlage mit diesem Namen ist bereits enthalten.",
      "An attachment with this name already exists.",
    ],
    "save-conflict": [
      "Die Datei wurde in einem anderen Editor geändert. Sichere deinen Arbeitsstand, bevor du sie erneut öffnest.",
      "The file changed in another editor. Save a working copy before reopening it.",
    ],
    "validation-timeout": [
      "Die Schemaprüfung hat zu lange gedauert. Bitte erneut prüfen.",
      "Schema validation timed out. Please check again.",
    ],
  };
  const message = messages[code];
  return message
    ? text(locale, ...message)
    : text(
        locale,
        "Die Aktion konnte nicht abgeschlossen werden. Deine Änderungen bleiben erhalten.",
        "The action could not be completed. Your changes are preserved.",
      );
}

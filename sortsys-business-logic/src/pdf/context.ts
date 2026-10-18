import { formatDecimal, formatEuro } from "../number.ts";
import { createPdfRenderer } from "./document.ts";
import {
  productTitle,
  regieProductTitle,
  userFullName,
  upmatchUnit,
  formatAddress,
} from "../domain.ts";
import * as calendar from "../calendar.ts";
export type PdfLocale = "de" | "en";
const words: Record<string, string> = {
  Hinweis: "Note",
  Datum: "Date",
  "Datum und Unterschrift": "Date and signature",
  Produkte: "Products",
  Bezeichnung: "Name",
  Menge: "Quantity",
  Projekt: "Project",
  Zusammenfassung: "Summary",
  Kennzahl: "Metric",
  Wert: "Value",
  Zeitraum: "Period",
  "Arbeitszeit je Mitarbeiter und Tag": "Work hours by employee and day",
  "Beschreibung der Arbeiten": "Description of work",
  "Keine Beschreibung": "No description",
  Sonderposten: "Additional items",
  Bauleiter: "Site manager",
  Bauherr: "Client",
  "Keine Daten zum Regiebericht verfugbar.":
    "No time-and-material report data available.",
  Tabellenexport: "Table export",
  Einträge: "Entries",
  Felder: "Fields",
  "Keine Daten vorhanden.": "No data available.",
  Übersicht: "Overview",
  Kommentar: "Comment",
  Gemeinkosten: "Overhead",
  Kosten: "Costs",
  Lieferschein: "Delivery note",
  Lieferscheine: "Delivery notes",
  Stunden: "Hours",
  Gesamt: "Total",
  Arbeitszeit: "Work hours",
  Werkzeuge: "Tools",
  Werkzeug: "Tool",
  Von: "From",
  Bis: "To",
  "Nachunternehmer-Arbeitszeit": "Subcontractor work hours",
  Nummer: "Number",
  Angebotssummen: "Offer totals",
  Rechnungssummen: "Invoice totals",
  Kostenbereiche: "Cost categories",
  Projektkostenbericht: "Project cost report",
  "Keine Kosteninformationen verfügbar.": "No cost information available.",
  Bautagesbericht: "Daily report",
  Fotos: "Photos",
  Wetter: "Weather",
  Beschreibung: "Description",
  "Keine Daten zum Bautagesbericht verfügbar.":
    "No daily report data available.",
  "Keine Daten zum Bauwochenbericht verfügbar.":
    "No weekly report data available.",
  "Anwesenheit je Mitarbeiter und Tag": "Attendance by employee and day",
  "Keine Arbeitszeiten vorhanden.": "No work hours available.",
  "Gewinn/Verlust kann nicht berechnet werden, da Rechnungssummen fehlen.":
    "Profit/loss cannot be calculated because invoice totals are missing.",
};
export function pdfLocale(locale: string): PdfLocale {
  return locale.toLowerCase().startsWith("de") ? "de" : "en";
}
const months = {
  de: [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};
export function createPdfBusinessContext(language: string) {
  const locale = pdfLocale(language);
  const uiText = (de: string, en?: string) =>
    locale === "de" ? de : (en ?? words[de] ?? de);
  const formatDate = (
    input: Date | string,
    style: "short" | "long" = "short",
  ) => {
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DAY");
    const day = date.getUTCDate(),
      month = date.getUTCMonth(),
      year = date.getUTCFullYear();
    return style === "long"
      ? locale === "de"
        ? `${day}. ${months.de[month]} ${year}`
        : `${months.en[month]} ${day}, ${year}`
      : locale === "de"
        ? `${String(day).padStart(2, "0")}.${String(month + 1).padStart(2, "0")}.${year}`
        : `${String(month + 1).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
  };
  const formatNumber = (value: number) => formatDecimal(value, locale, 2, 4);
  const formatCurrency = (value: number) => formatEuro(value, locale);
  const formatPercent = (value: number) =>
    `${formatDecimal(value, locale, 1, 1)}%`;
  const renderer = createPdfRenderer({
    locale: locale === "de" ? "de-DE" : "en-US",
    uiText,
    formatDate,
  });
  return {
    locale,
    uiText,
    formatDate,
    formatNumber,
    formatCurrency,
    formatPercent,
    ...renderer,
    productTitle,
    regieProductTitle,
    userFullName,
    upmatchUnit,
    formatAddress,
    startOfIsoWeek: (date: Date) => calendar.startOfIsoWeek(date, "UTC"),
    dayInIsoWeek: (date: Date, index: number) =>
      calendar.dayInIsoWeek(date, index, "UTC"),
    weekdayIndexInIsoWeek: (date: Date, start: Date) =>
      calendar.weekdayIndexInIsoWeek(date, start, "UTC"),
    isoWeekLabel: (date: Date) => calendar.isoWeekLabel(date, "UTC"),
    WEEKDAY_NAMES:
      locale === "de"
        ? calendar.WEEKDAY_NAMES
        : [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ],
    WEEKDAY_SHORT_NAMES:
      locale === "de"
        ? calendar.WEEKDAY_SHORT_NAMES
        : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  };
}

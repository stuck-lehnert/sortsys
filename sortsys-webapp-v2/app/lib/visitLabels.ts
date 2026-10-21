import { uiText } from "./i18n";

type VisitLabelInput = {
  path: string;
  title?: string | null;
};

export function visitLabel(visit: VisitLabelInput): string {
  const pathname = visit.path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const knownLabels: Record<string, string> = {
    "/dashboard": uiText("Dashboard"),
    "/projects": uiText("Projekte", "Projects"),
    "/regieReports": uiText("Regieberichte", "Time-and-material reports"),
    "/projects/costs": uiText("Kostenübersicht", "Cost overview"),
    "/deployments": uiText("Einsatzplanung", "Resource planning"),
    "/vacations": uiText("Abwesenheiten", "Absences"),
    "/tools": uiText("Werkzeuge", "Tools"),
    "/tools/trackings": uiText("Buchungshistorie", "Booking history"),
    "/inventories": uiText("Inventur", "Inventory"),
    "/products": uiText("Produkte", "Products"),
    "/import": uiText("Einlesen", "Import"),
    "/products/import": uiText("Einlesen", "Import"),
    "/products/deliveryNotes": uiText("Lieferscheine", "Delivery notes"),
    "/products/vendors": uiText("Händler", "Vendors"),
    "/customers": uiText("Kunden", "Customers"),
    "/contacts": uiText("Kontakte", "Contacts"),
    "/users": uiText("Benutzer", "Users"),
    "/settings": uiText("Einstellungen", "Settings"),
    "/docs": uiText("Hilfe & Begriffe", "Help & terms"),
    "/scripts": uiText("Client-Skripte", "Client scripts"),
    "/admin": uiText("Organisation", "Organization"),
  };

  if (/^\/(?:llm|assistant)(?:\/|$)/.test(pathname)) {
    return "LLM";
  }

  if (knownLabels[pathname]) {
    return knownLabels[pathname];
  }

  const title = visit.title?.trim().replace(/\s+[-|]\s+sortsys$/i, "");
  const isRouteTitle = title && /^(?:\/|https?:\/\/)/i.test(title);

  if (title && !isRouteTitle && !/^sortsys$/i.test(title)) {
    return title;
  }

  if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
    const tab = pathname.split("/")[3];
    const projectLabels: Record<string, string> = {
      costs: uiText("Projektkosten", "Project costs"),
      files: uiText("Projektanhänge", "Project attachments"),
      regieReports: uiText("Regieberichte", "Time-and-material reports"),
      dailyReports: uiText("Bautagesberichte", "Daily project reports"),
    };

    return projectLabels[tab] ?? uiText("Projekt", "Project");
  }

  return uiText("Seite", "Page");
}

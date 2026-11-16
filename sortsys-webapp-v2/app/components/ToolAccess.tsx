import { toolResources } from "~/lib/client";
import { toolCollection } from "~/lib/data/toolData";
import type { ToolChoice, ToolTrackingChoice } from "~/lib/data/tools";
import { formatDate, toolTitle } from "~/lib/format";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import {
  ResourceAccess,
  type ResourceAccessDefinition,
  type ResourceAccessProps,
} from "./ResourceAccess";

const tools: ResourceAccessDefinition<ToolChoice> = {
  heading: () => uiText("Werkzeugzugriff", "Tool access"),
  resourceLabel: () => uiText("Werkzeug", "Tool"),
  saveLabel: () => uiText("Werkzeugzugriff speichern", "Save tool access"),
  reloadLabel: () => uiText("Werkzeugfreigaben laden", "Reload tool access"),
  errorLabel: () =>
    uiText(
      "Die Werkzeugfreigaben konnten nicht aktualisiert werden.",
      "Tool access could not be updated.",
    ),
  load: (signal) => toolResources.tools(signal),
  describe: (tool) => `${tool.customId} ${toolTitle(tool)}`,
  fields: [
    {
      key: "master-data",
      label: () => uiText("Werkzeugstammdaten", "Tool master data"),
      area: (tool) => toolCollection("tool", tool.id, "master-data"),
    },
    {
      key: "procurement",
      label: () =>
        uiText("Anschaffung und Nutzungskosten", "Purchase and usage costs"),
      area: (tool) => toolCollection("tool", tool.id, "procurement"),
    },
    {
      key: "measurement",
      label: () => uiText("Werkzeuginventuren", "Tool inventories"),
      area: (tool) => toolCollection("tool", tool.id, "measurement"),
    },
  ],
};
const trackings: ResourceAccessDefinition<ToolTrackingChoice> = {
  heading: () => uiText("Werkzeugbuchungen", "Tool bookings"),
  resourceLabel: () => uiText("Werkzeugbuchung", "Tool booking"),
  saveLabel: () => uiText("Buchungszugriff speichern", "Save booking access"),
  reloadLabel: () => uiText("Buchungsfreigaben laden", "Reload booking access"),
  errorLabel: () =>
    uiText(
      "Die Buchungsfreigaben konnten nicht aktualisiert werden.",
      "Booking access could not be updated.",
    ),
  load: (signal) => toolResources.trackings(signal),
  describe: (tracking) => {
    const tool = tracking.tool;
    const name = tool
      ? `${tool.customId} ${toolTitle(tool)}`
      : uiText("Werkzeugbuchung", "Tool booking");
    const started = tracking.startedAt.toLocaleTimeString(currentLocaleTag(), {
      hour: "2-digit",
      minute: "2-digit",
    });
    let label = `${name} – ${formatDate(tracking.startedAt)}, ${started}`;
    if (tracking.endedAt) label += ` – ${formatDate(tracking.endedAt)}`;
    return label;
  },
  fields: [
    {
      key: "master-data",
      label: () => uiText("Buchungsdaten", "Booking details"),
      area: (tracking) =>
        toolCollection("tool-tracking", tracking.id, "master-data"),
    },
    {
      key: "procurement",
      label: () =>
        uiText("Historische Nutzungskosten", "Historical usage costs"),
      area: (tracking) =>
        toolCollection("tool-tracking", tracking.id, "procurement"),
    },
    {
      key: "scope",
      label: () => uiText("Umbuchungsanfragen", "Transfer requests"),
      area: (tracking) => toolCollection("tool-tracking", tracking.id, "scope"),
    },
  ],
};
export function ToolAccess(props: ResourceAccessProps) {
  return (
    <>
      <ResourceAccess {...props} definition={tools} />
      <ResourceAccess {...props} definition={trackings} />
    </>
  );
}

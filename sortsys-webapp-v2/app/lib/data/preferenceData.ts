import { DEFAULT_GAEB_VIEW, type GaebViewPreferences } from "@sortsys/gaeb";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import type { Collection } from "./protectedObjects";

export const PREFERENCE_QUERIES = new Set(["personalization.gaebView.get"]);
export const PREFERENCE_MUTATIONS = new Set([
  "personalization.gaebView.set",
  "settings.language.set",
]);
export function accountLocale(input: unknown): "de" | "en" {
  const data = record(input, ["locale"]);
  if (data.locale !== "de" && data.locale !== "en")
    throw new InvalidProtectedData();
  return data.locale;
}
const FIELDS = [
  "showFields",
  "outlineOpen",
  "outlineWidth",
  "ribbonCollapsed",
  "zoom",
];
export function preferenceCollection(subject: string): Collection {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData();
  addressId(subject.slice(5));
  const scope = `preferences:${subject}`;
  return {
    domain: `${scope}:master-data`,
    scope,
    facet: "master-data",
    prefix: `${scope}:`,
  };
}
export function gaebViewObject(subject: string): string {
  return preferenceCollection(subject).prefix + "gaeb-view";
}
export function gaebViewCollection(subject: string): Collection {
  return { ...preferenceCollection(subject), prefix: gaebViewObject(subject) };
}
export function preferenceDomain(domain: string): string | null {
  const match = /^preferences:(user:[1-9a-v][0-9a-v]{0,12}):master-data$/.exec(
    domain,
  );
  if (!match) return null;
  preferenceCollection(match[1]!);
  return match[1]!;
}
export function gaebView(input: unknown, legacy = false): GaebViewPreferences {
  const data = legacy
    ? { ...DEFAULT_GAEB_VIEW, ...partialAddressRecord(input, FIELDS) }
    : record(input, FIELDS);
  if (
    typeof data.showFields !== "boolean" ||
    typeof data.outlineOpen !== "boolean" ||
    typeof data.ribbonCollapsed !== "boolean" ||
    typeof data.outlineWidth !== "number" ||
    !Number.isInteger(data.outlineWidth) ||
    data.outlineWidth < 200 ||
    data.outlineWidth > 600 ||
    (data.zoom !== null &&
      (typeof data.zoom !== "number" ||
        !Number.isFinite(data.zoom) ||
        data.zoom < 0.25 ||
        data.zoom > 3))
  )
    throw new InvalidProtectedData();
  return {
    showFields: data.showFields,
    outlineOpen: data.outlineOpen,
    outlineWidth: data.outlineWidth,
    ribbonCollapsed: data.ribbonCollapsed,
    zoom: data.zoom as number | null,
  };
}
export function preferencePayload(
  input: unknown,
  object: string,
  subject: string,
) {
  const data = record(input, ["format", "subject", "view"]);
  if (
    object !== gaebViewObject(subject) ||
    data.format !== "sortsys-preferences-v1" ||
    data.subject !== subject
  )
    throw new InvalidProtectedData();
  return {
    format: "sortsys-preferences-v1" as const,
    subject,
    view: gaebView(data.view),
  };
}

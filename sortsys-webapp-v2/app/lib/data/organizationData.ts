import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { parseStartNumber, type OfferNumbering } from "../invoiceNumbering";
import type { Collection } from "./protectedObjects";

export const ORGANIZATION_COLLECTION: Collection = {
  domain: "organization:master-data",
  scope: "organization",
  facet: "master-data",
  prefix: "organization:profile:",
};
export const NUMBERING_COLLECTION: Collection = {
  domain: "organization:billing",
  scope: "organization",
  facet: "billing",
  prefix: "organization:billing:",
};
export const INVOICE_LEDGER_COLLECTION: Collection = {
  domain: "organization:invoicing:billing",
  scope: "organization:invoicing",
  facet: "billing",
  prefix: "organization:invoicing:billing:",
};
export const OFFER_NUMBERING_COLLECTION: Collection = {
  domain: "organization:offer-numbering:master-data",
  scope: "organization:offer-numbering",
  facet: "master-data",
  prefix: "organization:offer-numbering:master-data:",
};
export const OFFER_LEDGER_COLLECTION: Collection = {
  domain: "organization:offers:master-data",
  scope: "organization:offers",
  facet: "master-data",
  prefix: "organization:offers:master-data:",
};
export const PRINT_COLLECTION: Collection = {
  domain: "organization:attachment",
  scope: "organization",
  facet: "attachment",
  prefix: "organization:print:",
};
export const COMMON_COST_COLLECTION: Collection = {
  domain: "organization:calculation",
  scope: "organization",
  facet: "calculation",
  prefix: "organization:costs:",
};
export const CLIENT_SCRIPT_COLLECTION: Collection = {
  domain: "organization:scripts:master-data",
  scope: "organization:scripts",
  facet: "master-data",
  prefix: "client-script:",
};
export const ORGANIZATION_AREAS = [
  ORGANIZATION_COLLECTION,
  NUMBERING_COLLECTION,
  INVOICE_LEDGER_COLLECTION,
  OFFER_NUMBERING_COLLECTION,
  OFFER_LEDGER_COLLECTION,
  PRINT_COLLECTION,
  COMMON_COST_COLLECTION,
  CLIENT_SCRIPT_COLLECTION,
];
// Ordinary members need the sender's address when deriving an offer. This
// grant confers neither organization administration nor billing access.
export const MEMBER_ORGANIZATION_AREAS = [
  ORGANIZATION_COLLECTION,
  PRINT_COLLECTION,
];
export const ORGANIZATION_QUERIES = new Set([
  "settings.organization.get",
  "settings.invoiceNumbering.get",
]);
export const ORGANIZATION_MUTATIONS = new Set([
  "settings.organization.set",
  "settings.invoiceNumbering.set",
]);
export type OrganizationProfile = QueryResult<"settings.organization.get">;
export type Numbering = QueryResult<"settings.invoiceNumbering.get">;
export type OrganizationValues = {
  profile: OrganizationProfile;
  numbering: Numbering;
  offerNumbering: OfferNumbering;
};
export type OrganizationKind = keyof OrganizationValues;
export type OrganizationEdit<K extends OrganizationKind> = {
  value: OrganizationValues[K];
  save(value: OrganizationValues[K]): Promise<void>;
};
export type OrganizationPayload = {
  format: "sortsys-organization-v1";
  kind: OrganizationKind;
  value: OrganizationValues[OrganizationKind];
};
const documents = {
  profile: { area: ORGANIZATION_COLLECTION, name: "current" },
  numbering: { area: NUMBERING_COLLECTION, name: "invoice-numbering" },
  offerNumbering: { area: OFFER_NUMBERING_COLLECTION, name: "settings" },
};
export const organizationArea = (kind: OrganizationKind) => documents[kind].area;
export const organizationObject = (kind: OrganizationKind) =>
  organizationArea(kind).prefix + documents[kind].name;

function text(
  value: unknown,
  required = false,
  max = 1024 * 1024,
): string | null {
  if (value === null && !required) return null;
  if (typeof value !== "string" || value.includes("\0"))
    throw new InvalidProtectedData();
  const result = value.trim();
  if ((required && !result) || new TextEncoder().encode(result).length > max)
    throw new InvalidProtectedData();
  return result || null;
}
export function organizationProfile(
  input: unknown,
  requireName = false,
): OrganizationProfile {
  const data = record(input, ["companyName", "address"]);
  const companyName = text(data.companyName, requireName, 120);
  if (data.address === null) return { companyName, address: null };
  const address = record(data.address, [
    "streetAddress",
    "city",
    "zip",
    "country",
  ]);
  return {
    companyName,
    address: {
      streetAddress: text(address.streetAddress, true)!,
      city: text(address.city, true)!,
      zip: text(address.zip),
      country: text(address.country),
    },
  };
}
export function organizationNumbering(input: unknown): Numbering {
  const data = record(input, ["scheme", "startNumber"]);
  const startNumber = parseStartNumber(data.startNumber);
  if (
    typeof data.scheme !== "string" ||
    ![
      "sequential",
      "dateSeparated",
      "dateCompact",
      "projectLocal",
      "projectGlobal",
    ].includes(data.scheme) ||
    !startNumber
  )
    throw new InvalidProtectedData();
  return { scheme: data.scheme as Numbering["scheme"], startNumber };
}
export function offerNumbering(input: unknown): OfferNumbering {
  const { scheme, startNumber } = organizationNumbering(input);
  if (scheme === "projectLocal" || scheme === "projectGlobal") {
    throw new InvalidProtectedData();
  }

  return { scheme, startNumber };
}

export function organizationValue(kind: OrganizationKind, input: unknown, requireName = false) {
  switch (kind) {
    case "profile":
      return organizationProfile(input, requireName);
    case "numbering":
      return organizationNumbering(input);
    case "offerNumbering":
      return offerNumbering(input);
  }
}
export function organizationPayload(
  input: unknown,
  object: string,
  kind: OrganizationKind,
): OrganizationPayload {
  const data = record(input, ["format", "kind", "value"]);
  if (
    data.format !== "sortsys-organization-v1" ||
    data.kind !== kind ||
    object !== organizationObject(kind)
  )
    throw new InvalidProtectedData();
  return {
    format: data.format,
    kind,
    value: organizationValue(kind, data.value),
  };
}

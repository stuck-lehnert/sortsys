import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { parseStartNumber } from "../invoiceNumbering";
import type { Collection } from "./protectedObjects";

export const ORGANIZATION_COLLECTION: Collection = { domain: "organization:master-data", scope: "organization", facet: "master-data", prefix: "organization:profile:" };
export const NUMBERING_COLLECTION: Collection = { domain: "organization:billing", scope: "organization", facet: "billing", prefix: "organization:billing:" };
export const PRINT_COLLECTION: Collection = { domain: "organization:attachment", scope: "organization", facet: "attachment", prefix: "organization:print:" };
export const ORGANIZATION_AREAS = [ORGANIZATION_COLLECTION, NUMBERING_COLLECTION, PRINT_COLLECTION];
// Ordinary members need the sender's address when deriving an offer. This
// grant confers neither organization administration nor billing access.
export const MEMBER_ORGANIZATION_AREAS = [ORGANIZATION_COLLECTION, PRINT_COLLECTION];
export const ORGANIZATION_QUERIES = new Set(["settings.organization.get", "settings.invoiceNumbering.get"]);
export const ORGANIZATION_MUTATIONS = new Set(["settings.organization.set", "settings.invoiceNumbering.set"]);
export type OrganizationKind = "profile" | "numbering";
export type OrganizationProfile = QueryResult<"settings.organization.get">;
export type Numbering = QueryResult<"settings.invoiceNumbering.get">;
export type OrganizationValues = { profile: OrganizationProfile; numbering: Numbering };
export type OrganizationEdit<K extends OrganizationKind> = { value: OrganizationValues[K]; save(value: OrganizationValues[K]): Promise<void> };
export type OrganizationPayload = { format: "sortsys-organization-v1"; kind: OrganizationKind; value: OrganizationProfile | Numbering };
export const organizationArea = (kind: OrganizationKind) => kind === "profile" ? ORGANIZATION_COLLECTION : NUMBERING_COLLECTION;
export const organizationObject = (kind: OrganizationKind) => organizationArea(kind).prefix + (kind === "profile" ? "current" : "invoice-numbering");

function text(value: unknown, required = false, max = 1024 * 1024): string | null {
  if (value === null && !required) return null;
  if (typeof value !== "string" || value.includes("\0")) throw new InvalidProtectedData();
  const result = value.trim();
  if (required && !result || new TextEncoder().encode(result).length > max) throw new InvalidProtectedData();
  return result || null;
}
export function organizationProfile(input: unknown, requireName = false): OrganizationProfile {
  const data = record(input, ["companyName", "address"]);
  const companyName = text(data.companyName, requireName, 120);
  if (data.address === null) return { companyName, address: null };
  const address = record(data.address, ["streetAddress", "city", "zip", "country"]);
  return { companyName, address: { streetAddress: text(address.streetAddress, true)!, city: text(address.city, true)!,
    zip: text(address.zip), country: text(address.country) } };
}
export function organizationNumbering(input: unknown): Numbering {
  const data = record(input, ["scheme", "startNumber"]);
  const startNumber = parseStartNumber(data.startNumber);
  if (typeof data.scheme !== "string" || !["sequential", "dateSeparated", "dateCompact", "projectLocal", "projectGlobal"].includes(data.scheme) || !startNumber) throw new InvalidProtectedData();
  return { scheme: data.scheme as Numbering["scheme"], startNumber };
}
export function organizationPayload(input: unknown, object: string, kind: OrganizationKind): OrganizationPayload {
  const data = record(input, ["format", "kind", "value"]);
  if (data.format !== "sortsys-organization-v1" || data.kind !== kind || object !== organizationObject(kind)) throw new InvalidProtectedData();
  return { format: data.format, kind, value: kind === "profile" ? organizationProfile(data.value) : organizationNumbering(data.value) };
}

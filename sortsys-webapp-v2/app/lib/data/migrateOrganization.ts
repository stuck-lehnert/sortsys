import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { readBusinessRows } from "./products";
import type { BusinessRow } from "./rowCodec";
import { ORGANIZATION_AREAS, organizationArea, organizationObject, organizationPayload,
  organizationProfile, organizationNumbering, type OrganizationPayload } from "./organizationData";

/** Convert only the verified archive, never the mutable plaintext settings
 * endpoints. Extra legacy contact fields remain in the lossless source archive. */
export function organizationSource(settings: BusinessRow[]): OrganizationPayload[] {
  const contactRows = settings.filter(row => /^sortsys\.legacy\.organization\.[A-Za-z0-9_-]+$/.test(String(row.values.key)));
  if (contactRows.length !== 1) throw new InvalidProtectedData();
  const legacy = JSON.parse(contactRows[0]!.values.name as string);
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) throw new InvalidProtectedData();
  const address = legacy.address;
  const profile = organizationProfile({ companyName: legacy.companyName ?? null, address: address == null ? null : {
    streetAddress: address.streetAddress, city: address.city, zip: address.zip ?? null, country: address.country ?? null,
  } });
  const numberingRow = settings.find(row => row.values.key === "organization.invoiceNumbering");
  const numbering = organizationNumbering(numberingRow?.values.name != null ? JSON.parse(numberingRow.values.name as string) : { scheme: "sequential", startNumber: "1" });
  return [{ format: "sortsys-organization-v1", kind: "profile", value: profile }, { format: "sortsys-organization-v1", kind: "numbering", value: numbering }];
}
export async function prepareOrganization(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal): Promise<void> {
  const payloads = organizationSource(await readBusinessRows(source, "global_settings")); signal.throwIfAborted();
  await prepareOwnerCollections(client, subject, ORGANIZATION_AREAS, signal);
  for (const payload of payloads) {
    await copyProtectedCollection(client, organizationArea(payload.kind), [{ id: organizationObject(payload.kind), value: payload }],
      (input, object) => organizationPayload(input, object, payload.kind), signal);
  }
}

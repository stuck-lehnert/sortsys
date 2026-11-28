import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId } from "./products";
import {
  supervisorSettingsRequest,
  supervisorUserId,
  SUPERVISOR_SETTINGS_ID,
  type SupervisorSettings,
} from "./supervisorSettingsData";
import type { BusinessRow } from "./rowCodec";
import {
  ORGANIZATION_AREAS,
  offerNumbering,
  organizationArea,
  organizationObject,
  organizationPayload,
  organizationProfile,
  organizationNumbering,
  type OrganizationPayload,
} from "./organizationData";

const DEFAULT_SUPERVISOR_SETTING = "users.defaultSupervisorUserId";

/** Convert only the verified archive, never the mutable plaintext settings
 * endpoints. Extra legacy contact fields remain in the lossless source archive. */
export function organizationSource(
  settings: BusinessRow[],
  suppliedProfile?: ReturnType<typeof organizationProfile>,
): OrganizationPayload[] {
  const contactRows = settings.filter((row) =>
    /^sortsys\.legacy\.organization\.[A-Za-z0-9_-]+$/.test(
      String(row.values.key),
    ),
  );
  if (
    contactRows.length > 1 ||
    (contactRows.length === 0 && suppliedProfile === undefined)
  )
    throw new InvalidProtectedData();
  const legacy =
    contactRows.length === 1
      ? JSON.parse(contactRows[0]!.values.name as string)
      : suppliedProfile;
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
    throw new InvalidProtectedData();
  const address = legacy.address;
  const profile = organizationProfile({
    companyName: legacy.companyName ?? null,
    address:
      address == null
        ? null
        : {
            streetAddress: address.streetAddress,
            city: address.city,
            zip: address.zip ?? null,
            country: address.country ?? null,
          },
  });
  const numberingRow = settings.find(
    (row) => row.values.key === "organization.invoiceNumbering",
  );
  const numbering = organizationNumbering(
    numberingRow?.values.name != null
      ? JSON.parse(numberingRow.values.name as string)
      : { scheme: "sequential", startNumber: "1" },
  );
  const offerNumberingRow = settings.find(
    (row) => row.values.key === "organization.offerNumbering",
  );
  const offers = offerNumbering(
    offerNumberingRow?.values.name != null
      ? JSON.parse(offerNumberingRow.values.name as string)
      : { scheme: "sequential", startNumber: "1" },
  );
  return [
    { format: "sortsys-organization-v1", kind: "profile", value: profile },
    { format: "sortsys-organization-v1", kind: "numbering", value: numbering },
    { format: "sortsys-organization-v1", kind: "offerNumbering", value: offers },
  ];
}
export async function prepareOrganization(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
  suppliedProfile?: ReturnType<typeof organizationProfile>,
): Promise<void> {
  const settings = await readBusinessRows(source, "global_settings");
  const payloads = organizationSource(settings, suppliedProfile);
  signal.throwIfAborted();
  await prepareOwnerCollections(client, subject, ORGANIZATION_AREAS, signal);
  for (const payload of payloads) {
    const area = {
      ...organizationArea(payload.kind),
      prefix: organizationObject(payload.kind),
    };
    await copyProtectedCollection(
      client,
      area,
      [{ id: organizationObject(payload.kind), value: payload }],
      (input, object) => organizationPayload(input, object, payload.kind),
      signal,
    );
  }
  if (!settings.some((row) => row.values.key === DEFAULT_SUPERVISOR_SETTING))
    return;
  const supervisor = supervisorSettingsFromBackup(
    settings,
    await readBusinessRows(source, "users"),
  );
  if (supervisor) {
    const { area, model } = supervisorSettingsRequest;
    await copyProtectedCollection(
      client,
      area,
      [{ id: SUPERVISOR_SETTINGS_ID, value: supervisor }],
      (value, object) => model.decode(value, object, area),
      signal,
    );
  }
}

/** The archived setting used decimal IDs inside a JSON string. Keep exact
 * integers, and retain a stale source reference only in the original archive. */
export function supervisorSettingsFromBackup(
  settings: BusinessRow[],
  people: BusinessRow[],
): SupervisorSettings | null {
  const matching = settings.filter(
    (row) => row.values.key === DEFAULT_SUPERVISOR_SETTING,
  );
  if (matching.length > 1) throw new InvalidProtectedData();
  const selected = matching[0];
  if (!selected) return null;
  let configured: unknown = null;
  try {
    if (selected.values.name !== null)
      configured = JSON.parse(selected.values.name as string);
  } catch {
    throw new InvalidProtectedData();
  }
  let userId: string | null = null;
  if (configured !== null) {
    const encoded = supervisorUserId(publicId(configured));
    if (people.some((person) => person.values.id === configured))
      userId = encoded;
  }
  return { format: "sortsys-supervisor-settings-v1", userId };
}

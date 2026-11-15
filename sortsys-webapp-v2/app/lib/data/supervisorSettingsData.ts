import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { ORGANIZATION_COLLECTION } from "./organizationData";
import { defineDataModel } from "./runtime/model";
import type { DataView } from "./runtime/runtime";

export const SUPERVISOR_QUERIES = new Set(["users.supervisors.getDefault"]);
export const SUPERVISOR_MUTATIONS = new Set(["users.supervisors.setDefault"]);
export const SUPERVISOR_SETTINGS_ID = "organization:profile:supervisors";
export type SupervisorSettings = {
  format: "sortsys-supervisor-settings-v1";
  userId: string | null;
};

export function supervisorUserId(value: unknown): string | null {
  if (value === null) return null;
  addressId(value);
  return value as string;
}

const model = defineDataModel<SupervisorSettings>({
  name: "supervisor-settings",
  tables: [],
  sources: () => [],
  decode(input, object, area) {
    const value = record(input, ["format", "userId"]);
    if (
      object !== SUPERVISOR_SETTINGS_ID ||
      area.domain !== ORGANIZATION_COLLECTION.domain ||
      area.scope !== ORGANIZATION_COLLECTION.scope ||
      area.facet !== ORGANIZATION_COLLECTION.facet ||
      value.format !== "sortsys-supervisor-settings-v1"
    )
      throw new InvalidProtectedData();
    return { format: value.format, userId: supervisorUserId(value.userId) };
  },
});

export const supervisorSettingsRequest = {
  model,
  area: { ...ORGANIZATION_COLLECTION, prefix: SUPERVISOR_SETTINGS_ID },
  ids: [SUPERVISOR_SETTINGS_ID],
};

/** The complete, verified absence of this optional setting means no fallback.
 * A failed read or an invalid signature never becomes an empty setting. */
export function defaultSupervisor(view: DataView): string | null {
  const documents = view.documents(supervisorSettingsRequest);
  if (documents.length === 0) return null;
  if (documents.length !== 1) {
    throw new InvalidProtectedData();
  }
  const document = documents[0]!;
  // Revision zero exists only inside a prepared DataRuntime transaction.
  if (!document.signature && document.revision !== "0")
    throw new InvalidProtectedData();
  return document.value.userId;
}

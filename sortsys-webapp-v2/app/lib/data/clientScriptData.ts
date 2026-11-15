import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { CLIENT_SCRIPT_COLLECTION } from "./organizationData";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";

export { CLIENT_SCRIPT_COLLECTION };
export const CLIENT_SCRIPT_QUERIES = new Set([
  "clientScripts.list",
  "clientScripts.get",
]);
export const CLIENT_SCRIPT_MUTATIONS = new Set([
  "clientScripts.create",
  "clientScripts.update",
  "clientScripts.delete",
]);
export type ClientScriptPayload = {
  format: "sortsys-client-script-v1";
  row: BusinessRow;
};
export type ClientScriptDetail = NonNullable<QueryResult<"clientScripts.get">>;
type ScriptFields = Pick<
  ClientScriptDetail,
  "name" | "description" | "code" | "enabled"
>;

function scriptText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > maximum
  ) {
    throw new InvalidProtectedData();
  }
  return value;
}

export function clientScriptObject(rawId: unknown): string {
  const id = publicId(rawId);
  addressId(id);
  return `${CLIENT_SCRIPT_COLLECTION.prefix}${id}`;
}

export function clientScriptPayload(
  input: unknown,
  object: string,
): ClientScriptPayload {
  const value = record(input, ["format", "row"]);
  const row = decodeBusinessRow(value.row);
  if (
    value.format !== "sortsys-client-script-v1" ||
    row.table !== "client_scripts" ||
    object !== clientScriptObject(row.values.id)
  ) {
    throw new InvalidProtectedData();
  }
  const fields = row.values;
  if (!scriptText(fields.name, 160).trim()) throw new InvalidProtectedData();
  if (fields.description !== null) scriptText(fields.description, 2000);
  scriptText(fields.code, 200000);
  for (const field of ["created_by_user_id", "modified_by_user_id"]) {
    if (fields[field] !== null) addressId(publicId(fields[field]));
  }
  return { format: value.format, row };
}

export const CLIENT_SCRIPT_MODEL = defineDataModel<ClientScriptPayload>({
  name: "client-scripts",
  tables: ["client_scripts"],
  externalReferences: ["users"],
  decode(value, object, area) {
    if (
      area.domain !== CLIENT_SCRIPT_COLLECTION.domain ||
      area.scope !== CLIENT_SCRIPT_COLLECTION.scope ||
      area.facet !== CLIENT_SCRIPT_COLLECTION.facet ||
      area.prefix !== CLIENT_SCRIPT_COLLECTION.prefix
    ) {
      throw new InvalidProtectedData();
    }
    return clientScriptPayload(value, object);
  },
});
export const clientScriptRequest = {
  model: CLIENT_SCRIPT_MODEL,
  area: CLIENT_SCRIPT_COLLECTION,
};

export function clientScriptChanges(
  input: unknown,
  creating: boolean,
): Partial<ScriptFields> {
  const keys = ["name", "description", "code", "enabled"];
  const data = partialAddressRecord(input, keys);
  if (creating && (data.name === undefined || data.code === undefined))
    throw new InvalidProtectedData();
  if (!creating && Object.keys(data).length === 0)
    throw new InvalidProtectedData();
  const result: Partial<ScriptFields> = {};
  if (Object.hasOwn(data, "name")) {
    const name = scriptText(data.name, 160).trim();
    if (!name) throw new InvalidProtectedData();
    result.name = name;
  }
  if (Object.hasOwn(data, "description")) {
    result.description =
      data.description === null
        ? null
        : scriptText(data.description, 2000).trim() || null;
  } else if (creating) {
    result.description = null;
  }
  if (Object.hasOwn(data, "code")) result.code = scriptText(data.code, 200000);
  if (Object.hasOwn(data, "enabled")) {
    if (typeof data.enabled !== "boolean") throw new InvalidProtectedData();
    result.enabled = data.enabled;
  } else if (creating) {
    result.enabled = true;
  }
  return result;
}

export function wireClientScript(
  payload: ClientScriptPayload,
): ClientScriptDetail {
  const fields = payload.row.values;
  const optionalId = (value: unknown) =>
    value === null ? null : publicId(value);
  return {
    id: publicId(fields.id),
    name: fields.name as string,
    description: fields.description as string | null,
    code: fields.code as string,
    enabled: fields.enabled as boolean,
    createdByUserId: optionalId(fields.created_by_user_id),
    modifiedByUserId: optionalId(fields.modified_by_user_id),
    createdAt: new Date(fields.created_at as string),
    modifiedAt: new Date(fields.modified_at as string),
  };
}

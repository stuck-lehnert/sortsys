import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import type { Collection } from "./protectedObjects";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { publicId } from "./products";
import { businessSchema, tableDefinition } from "./schema";
import { decodeBusinessFields, type BusinessRow } from "./rowCodec";
import { defineDataModel, UNLOADED } from "./runtime/model";
import type { DataView } from "./runtime/runtime";

export const PERSONNEL_FACETS = [
  "master-data",
  "scope",
  "calculation",
] as const;
export type PersonnelFacet = (typeof PERSONNEL_FACETS)[number];
export type PersonnelPart = {
  format: "sortsys-personnel-v1";
  schema: string;
  id: string;
  facet: PersonnelFacet;
  values: Record<string, unknown>;
};
export const PERSONNEL_QUERIES = new Set(["users.list", "users.get"]);
export const PERSONNEL_MUTATIONS = new Set([
  "users.create",
  "users.update",
  "users.delete",
  "users.activate",
  "users.deactivate",
  "users.archive",
  "users.unarchive",
]);
const PRIVATE_PERSONNEL_COLUMNS = [
  "cost_per_hour",
  "vacation_days_per_year",
  "supervisor_user_id",
];
export function personnelColumns(facet: PersonnelFacet): string[] {
  switch (facet) {
    case "calculation":
      return ["id", "cost_per_hour"];
    case "scope":
      return ["id", "vacation_days_per_year", "supervisor_user_id"];
    default:
      // Current language belongs to authentication metadata. The original
      // source column remains in the verified archive, not a second live copy.
      return tableDefinition("users")
        .columns.map((column) => column.name)
        .filter(
          (name) =>
            name !== "ui_locale" && !PRIVATE_PERSONNEL_COLUMNS.includes(name),
        );
  }
}
export function personnelCollection(
  id: string,
  facet: PersonnelFacet,
): Collection {
  addressId(id);
  if (!PERSONNEL_FACETS.includes(facet)) throw new InvalidProtectedData();
  const scope = `personnel:${id}`;
  return {
    domain: `${scope}:${facet}`,
    scope,
    facet,
    prefix: `${scope}:${facet}:record`,
  };
}
export function personnelDomain(
  domain: string,
): { id: string; facet: PersonnelFacet } | null {
  const match =
    /^personnel:([1-9a-v][0-9a-v]{0,12}):(master-data|scope|calculation)$/.exec(
      domain,
    );
  if (!match) return null;
  addressId(match[1]);
  return { id: match[1]!, facet: match[2] as PersonnelFacet };
}
export const PERSONNEL_MODEL = defineDataModel<PersonnelPart>({
  name: "personnel",
  tables: ["users"],
  externalReferences: ["users"],
  decode(input, object, area) {
    const part = personnelDomain(area.domain);
    const data = record(input, ["format", "schema", "id", "facet", "values"]);
    if (
      !part ||
      object !== personnelCollection(part.id, part.facet).prefix ||
      area.scope !== `personnel:${part.id}` ||
      area.facet !== part.facet ||
      data.format !== "sortsys-personnel-v1" ||
      data.schema !== businessSchema.fingerprint ||
      data.id !== part.id ||
      data.facet !== part.facet
    )
      throw new InvalidProtectedData();
    const values = decodeBusinessFields(
      "users",
      record(data.values, personnelColumns(part.facet)),
    ).values;
    for (const column of ["supervisor_user_id", "created_by_user_id"])
      if (values[column] != null) addressId(publicId(values[column]));
    if (values.id !== addressId(part.id)) throw new InvalidProtectedData();
    if (values.cost_per_hour != null && (values.cost_per_hour as number) < 0) {
      throw new InvalidProtectedData();
    }
    if (values.vacation_days_per_year != null) {
      const vacationDays = Number(values.vacation_days_per_year);
      if (vacationDays < 0 || vacationDays > 366) {
        throw new InvalidProtectedData();
      }
    }
    if (
      values.supervisor_user_id != null &&
      values.supervisor_user_id === values.id
    ) {
      throw new InvalidProtectedData();
    }
    if (part.facet === "master-data") {
      if (
        !["internal", "external", "subcontractor"].includes(
          values.contract_type as string,
        )
      ) {
        throw new InvalidProtectedData();
      }
      if (typeof values.first_name !== "string" || !values.first_name.trim()) {
        throw new InvalidProtectedData();
      }
      if (
        typeof values.username !== "string" ||
        !values.username ||
        values.username !== values.username.toLowerCase()
      ) {
        throw new InvalidProtectedData();
      }
    }
    return {
      format: "sortsys-personnel-v1",
      schema: businessSchema.fingerprint,
      ...part,
      values,
    };
  },
  sources: (value) => [
    {
      table: "users",
      kind: value.facet === "master-data" ? "entity" : "fragment",
      values: value.values,
      fields: Object.fromEntries(
        Object.keys(value.values).map((name) => [
          name,
          { path: ["values", name] },
        ]),
      ),
    },
  ],
});
export const personnelRequest = (id: string, facet: PersonnelFacet) => ({
  model: PERSONNEL_MODEL,
  area: personnelCollection(id, facet),
});
export function personnelPart(
  row: BusinessRow,
  facet: PersonnelFacet,
): PersonnelPart {
  if (row.table !== "users") throw new InvalidProtectedData();
  const id = publicId(row.values.id);
  const area = personnelCollection(id, facet);
  return PERSONNEL_MODEL.decode(
    {
      format: "sortsys-personnel-v1",
      schema: businessSchema.fingerprint,
      id,
      facet,
      values: Object.fromEntries(
        personnelColumns(facet).map((name) => [name, row.values[name]]),
      ),
    },
    area.prefix,
    area,
  );
}
export function newPersonnelProfile(
  id: string,
  username: string,
  createdAt: string,
  creator: string | null,
  locale: string,
  changes: Record<string, unknown> = {},
): BusinessRow {
  const row: BusinessRow = {
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table: "users",
    values: {
      salutation: null,
      first_name: username,
      last_name: null,
      email: null,
      phone: null,
      contract_type: "internal",
      cost_per_hour: null,
      deactivated_at: null,
      archived_at: null,
      supervisor_user_id: null,
      vacation_days_per_year: null,
      ...changes,
      id: addressId(id),
      username,
      created_by_user_id: creator === null ? null : addressId(creator),
      created_at: createdAt,
      modified_at: createdAt,
      ui_locale: locale,
    },
  };
  decodeBusinessFields("users", row.values);
  for (const facet of PERSONNEL_FACETS) personnelPart(row, facet);
  return row;
}
export function wirePersonnel(view: DataView, id: string) {
  const row = view.row("users", { id: addressId(id) });
  const fields = row.pick(personnelColumns("master-data"));
  const optional = (column: string) => {
    const value = row.get(column);
    return value === UNLOADED ? null : value;
  };
  return {
    id,
    salutation: fields.salutation as string | null,
    firstName: fields.first_name as string,
    lastName: fields.last_name as string | null,
    username: fields.username as string,
    email: fields.email as string | null,
    phone: fields.phone as string | null,
    contractType: fields.contract_type as
      | "internal"
      | "external"
      | "subcontractor",
    costPerHour: optional("cost_per_hour") as number | null,
    vacationDaysPerYear:
      optional("vacation_days_per_year") === null
        ? null
        : Number(optional("vacation_days_per_year")),
    supervisorUserId:
      optional("supervisor_user_id") === null
        ? null
        : publicId(optional("supervisor_user_id")),
    createdAt: new Date(fields.created_at as string),
    modifiedAt: new Date(fields.modified_at as string),
    deactivatedAt:
      fields.deactivated_at === null
        ? null
        : new Date(fields.deactivated_at as string),
    archivedAt:
      fields.archived_at === null
        ? null
        : new Date(fields.archived_at as string),
  };
}
export function personnelChanges(input: unknown) {
  const data = partialAddressRecord(input, [
    "username",
    "firstName",
    "lastName",
    "email",
    "phone",
    "contractType",
    "costPerHour",
    "vacationDaysPerYear",
    "supervisorUserId",
  ]);
  const result: Record<string, unknown> = {};
  for (const [property, column] of [
    ["firstName", "first_name"],
    ["lastName", "last_name"],
    ["email", "email"],
    ["phone", "phone"],
  ])
    if (Object.hasOwn(data, property!))
      result[column!] = addressText(
        data[property!],
        property === "firstName",
        property === "phone" ? 63 : 127,
      );
  if (Object.hasOwn(data, "username")) {
    if (typeof data.username !== "string") throw new InvalidProtectedData();
    result.username = data.username.trim().toLowerCase();
  }
  if (data.contractType != null) {
    if (
      !["internal", "external", "subcontractor"].includes(
        data.contractType as string,
      )
    )
      throw new InvalidProtectedData();
    result.contract_type = data.contractType;
  }
  if (Object.hasOwn(data, "costPerHour")) {
    if (
      data.costPerHour !== null &&
      (typeof data.costPerHour !== "number" ||
        !Number.isFinite(data.costPerHour) ||
        data.costPerHour < 0)
    )
      throw new InvalidProtectedData();
    result.cost_per_hour = data.costPerHour;
  }
  if (Object.hasOwn(data, "vacationDaysPerYear")) {
    if (
      data.vacationDaysPerYear !== null &&
      (typeof data.vacationDaysPerYear !== "number" ||
        !Number.isInteger(data.vacationDaysPerYear) ||
        data.vacationDaysPerYear < 0 ||
        data.vacationDaysPerYear > 366)
    )
      throw new InvalidProtectedData();
    result.vacation_days_per_year =
      data.vacationDaysPerYear === null
        ? null
        : String(data.vacationDaysPerYear);
  }
  if (Object.hasOwn(data, "supervisorUserId"))
    result.supervisor_user_id =
      data.supervisorUserId === null ? null : addressId(data.supervisorUserId);
  return result;
}

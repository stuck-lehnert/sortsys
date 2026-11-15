import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "./database";
import { acquireDataRuntime } from "./runtime/session";
import { defineDataModel } from "./runtime/model";
import type { DataRequest, DataView } from "./runtime/runtime";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { newProductRowId, publicId } from "./products";
import { required, type Collection } from "./protectedObjects";

export const CUSTOMER_COLLECTION: Collection = {
  domain: "catalog:customers:master-data",
  scope: "catalog:customers",
  facet: "master-data",
  prefix: "customer:",
};
export const CONTACT_COLLECTION: Collection = {
  domain: "catalog:contacts:master-data",
  scope: "catalog:contacts",
  facet: "master-data",
  prefix: "contact:",
};
export const ADDRESS_QUERIES = new Set([
  "customers.list",
  "customers.get",
  "contacts.list",
  "contacts.get",
  "customers.contacts.list",
  "contacts.customers.list",
]);
export const ADDRESS_MUTATIONS = new Set([
  "customers.create",
  "customers.update",
  "customers.delete",
  "contacts.create",
  "contacts.update",
  "contacts.delete",
  "customers.contacts.add",
  "customers.contacts.set",
  "customers.contacts.remove",
]);
type Kind = "customers" | "contacts";
type Customer = QueryResult<"customers.get">;
type Contact = QueryResult<"contacts.get">;
export type AddressPayload = {
  format: "sortsys-address-v1";
  kind: Kind;
  row: BusinessRow | null;
  links: BusinessRow[];
};
const area = (kind: Kind) =>
  kind === "customers" ? CUSTOMER_COLLECTION : CONTACT_COLLECTION;
function partial(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidProtectedData();
  return value as Record<string, unknown>;
}

export function addressId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9a-v][0-9a-v]{0,12}$/.test(value))
    throw new InvalidProtectedData();
  let integer = 0n;
  for (const char of value)
    integer = integer * 32n + BigInt(parseInt(char, 32));
  if (integer > 9223372036854775807n) throw new InvalidProtectedData();
  return integer.toString();
}
function string(
  value: unknown,
  required = false,
  max = Infinity,
): string | null {
  if (value == null && !required) return null;
  if (typeof value !== "string" || value.includes("\0"))
    throw new InvalidProtectedData();
  const result = value.trim();
  if (new TextEncoder().encode(result).length > max || (required && !result))
    throw new InvalidProtectedData();
  return result || null;
}
function address(value: unknown): Customer["address"] {
  if (value == null) return null;
  const data = partial(value, ["streetAddress", "city", "country", "zip"]);
  return {
    streetAddress: string(data.streetAddress, true)!,
    city: string(data.city, true)!,
    country: string(data.country),
    zip: string(data.zip),
  };
}
function channels(
  value: unknown,
  kind: "phone" | "email",
): Customer["phoneNumbers"] | Customer["emailAddresses"] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new InvalidProtectedData();
  return value.map((input) => {
    const key = kind === "phone" ? "number" : "email",
      data = partial(input, [key, "name"]);
    const content = string(data[key], true)!,
      name = string(data.name);
    // Accept quoted local parts and literal domains as well as ordinary forms.
    if (
      kind === "email" &&
      !/^(?:"(?:[^"\\\r\n]|\\[^\r\n])*"|[^\s@"(),:;<>\[\]\\]+)@(?:\[[^\]\r\n]+\]|[^\s@"(),:;<>\[\]\\]+)$/u.test(
        content,
      )
    )
      throw new InvalidProtectedData();
    return { [key]: content, name } as
      | Customer["phoneNumbers"][number]
      | Customer["emailAddresses"][number];
  }) as Customer["phoneNumbers"] | Customer["emailAddresses"];
}
const FIELDS = {
  salutation: "salutation",
  name: "name",
  firstName: "first_name",
  lastName: "last_name",
  address: "address",
  phoneNumbers: "phone_numbers",
  emailAddresses: "email_addresses",
};
export function addressChanges(
  input: unknown,
  kind: Kind,
  creating: boolean,
): Record<string, unknown> {
  const keys = Object.keys(FIELDS).filter((key) =>
    kind === "customers"
      ? !["firstName", "lastName"].includes(key)
      : key !== "name",
  );
  const source = partial(input, keys),
    values: Record<string, unknown> = {};
  for (const field of keys) {
    if (source[field] === undefined && !creating) continue;
    const value = source[field],
      column = FIELDS[field as keyof typeof FIELDS];
    if (field === "address")
      values[column] = value == null ? null : JSON.stringify(address(value));
    else if (field === "phoneNumbers" || field === "emailAddresses")
      values[column] = JSON.stringify(
        channels(
          value === undefined && creating ? [] : value,
          field === "phoneNumbers" ? "phone" : "email",
        ),
      );
    else
      values[column] = string(
        value,
        field === "name",
        ["name", "firstName", "lastName"].includes(field) ? 127 : Infinity,
      );
  }
  if (!creating && !Object.keys(values).length)
    throw new InvalidProtectedData();
  return values;
}
export function addressPayload(
  input: unknown,
  object: string,
  kind: Kind,
): AddressPayload {
  const data = record(input, ["format", "kind", "row", "links"]);
  addressId(object.slice(area(kind).prefix.length));
  if (
    !object.startsWith(area(kind).prefix) ||
    data.format !== "sortsys-address-v1" ||
    data.kind !== kind ||
    !Array.isArray(data.links) ||
    data.links.length > 10000
  )
    throw new InvalidProtectedData();
  if (data.row === null) {
    if (data.links.length) throw new InvalidProtectedData();
    return { format: data.format, kind, row: null, links: [] };
  }
  const row = decodeBusinessRow(data.row),
    p = row.values;
  if (row.table !== kind || object !== area(kind).prefix + publicId(p.id))
    throw new InvalidProtectedData();
  string(p.salutation);
  if (kind === "customers") {
    string(p.name, true, 127);
    if (p.created_by_user_id !== null) publicId(p.created_by_user_id);
  } else if (
    !string(p.first_name, false, 127) &&
    !string(p.last_name, false, 127)
  )
    throw new InvalidProtectedData();
  if (kind === "contacts") {
    string(p.first_name, false, 127);
    string(p.last_name, false, 127);
  }
  address(p.address === null ? null : JSON.parse(p.address as string));
  channels(JSON.parse(p.phone_numbers as string), "phone");
  channels(JSON.parse(p.email_addresses as string), "email");
  const seen = new Set<string>();
  const links = data.links
    .map((value) => {
      const link = decodeBusinessRow(value);
      if (
        kind !== "customers" ||
        link.table !== "customer_contacts" ||
        link.values.customer_id !== p.id
      )
        throw new InvalidProtectedData();
      const contact = publicId(link.values.contact_id);
      addressId(contact);
      if (seen.has(contact)) throw new InvalidProtectedData();
      seen.add(contact);
      return link;
    })
    .sort((a, b) =>
      (a.values.contact_id as string).localeCompare(
        b.values.contact_id as string,
      ),
    );
  return { format: data.format, kind, row, links };
}
function wire(payload: AddressPayload): Customer | Contact {
  if (!payload.row) throw new InvalidProtectedData();
  const p = payload.row.values;
  const common = {
    id: publicId(p.id),
    salutation: p.salutation as string | null,
    address: p.address === null ? null : JSON.parse(p.address as string),
    phoneNumbers: JSON.parse(p.phone_numbers as string),
    emailAddresses: JSON.parse(p.email_addresses as string),
    createdAt: new Date(p.created_at as string),
    modifiedAt: new Date(p.modified_at as string),
  };
  return payload.kind === "customers"
    ? {
        ...common,
        name: p.name as string,
        createdByUserId:
          p.created_by_user_id === null ? null : publicId(p.created_by_user_id),
      }
    : {
        ...common,
        firstName: p.first_name as string | null,
        lastName: p.last_name as string | null,
      };
}
export function addressMatches(
  value: Customer | Contact,
  search: unknown,
): boolean {
  if (search != null && typeof search !== "string")
    throw new InvalidProtectedData();
  const terms =
    (search as string | null | undefined)
      ?.trim()
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  if ((search as string | null | undefined)?.trim() && !terms.length)
    return false;
  const words =
    [
      value.salutation,
      ...("name" in value ? [value.name] : [value.firstName, value.lastName]),
      ...Object.values(value.address ?? {}),
      ...value.phoneNumbers.map((phone) => phone.number),
      ...value.emailAddresses.map((email) => email.email),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu) ?? [];
  return terms.every((term) => words.some((word) => word.startsWith(term)));
}
function compare(a: Customer | Contact, b: Customer | Contact): number {
  const names = (v: Customer | Contact) =>
    "name" in v ? [v.name] : [v.lastName, v.firstName];
  const left = names(a),
    right = names(b);
  for (let index = 0; index < left.length; index++) {
    if (left[index] === null && right[index] !== null) return 1;
    if (right[index] === null && left[index] !== null) return -1;
    const compared = (left[index] ?? "")
      .toLowerCase()
      .localeCompare((right[index] ?? "").toLowerCase());
    if (compared) return compared;
  }
  return a.id.localeCompare(b.id);
}

export const CUSTOMER_MODEL = defineDataModel({
  name: "customers",
  decode: (value: unknown, id: string) =>
    addressPayload(value, id, "customers"),
  externalReferences: ["users", "contacts"],
});
export const CONTACT_MODEL = defineDataModel({
  name: "contacts",
  decode: (value: unknown, id: string) => addressPayload(value, id, "contacts"),
});
const request = (kind: Kind): DataRequest<AddressPayload> => ({
  model: kind === "customers" ? CUSTOMER_MODEL : CONTACT_MODEL,
  area: area(kind),
});
const customerRequest = request("customers"),
  contactRequest = request("contacts");
function payloads(view: DataView, kind: Kind) {
  return view.documents(request(kind)).map((document) => document.value);
}
function find(values: AddressPayload[], id: unknown): AddressPayload {
  addressId(id);
  const value = values.find(
    (payload) => payload.row && publicId(payload.row.values.id) === id,
  );
  if (!value) throw new InvalidProtectedData();
  return value;
}

export function createProtectedAddressBook(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  return {
    close: lease.close,
    async references(
      kind: Kind,
      ids: string[],
    ): Promise<{ domain: string; sequence: string }> {
      lease.live();
      runtime.revalidate();
      const selected = request(kind);
      const result = await runtime.read([selected], (view) => {
        const values = payloads(view, kind);
        for (const id of ids) find(values, id);
        return view.head(selected);
      });
      lease.live();
      return result;
    },
    async refresh(domains?: Record<string, string | null>) {
      lease.live();
      const domainsToRefresh = [
        CUSTOMER_COLLECTION.domain,
        CONTACT_COLLECTION.domain,
      ].filter((domain) => !domains || Object.hasOwn(domains, domain));
      runtime.invalidate(
        new Set(domainsToRefresh),
        domains
          ? new Map(
              Object.entries(domains).filter(
                (entry): entry is [string, string] => entry[1] !== null,
              ),
            )
          : undefined,
      );
    },
    async query(path: string, input: unknown): Promise<unknown> {
      lease.live();
      if (!ADDRESS_QUERIES.has(path)) throw new InvalidProtectedData();
      if (
        path === "customers.contacts.list" ||
        path === "contacts.customers.list"
      ) {
        const fromCustomer = path.startsWith("customers."),
          data = record(input, [fromCustomer ? "customerId" : "contactId"]),
          id = data[fromCustomer ? "customerId" : "contactId"];
        addressId(id);
        const result = await runtime.read(
          [customerRequest, contactRequest],
          (view) => {
            const customers = payloads(view, "customers"),
              contacts = payloads(view, "contacts");
            if (fromCustomer) {
              const customer = find(customers, id),
                ids = new Set(
                  customer.links.map((link) => link.values.contact_id),
                );
              return contacts
                .filter(
                  (contact) => contact.row && ids.has(contact.row.values.id),
                )
                .map(wire)
                .sort(compare);
            }
            const contact = find(contacts, id);
            return customers
              .filter(
                (customer) =>
                  customer.row &&
                  customer.links.some(
                    (link) => link.values.contact_id === contact.row!.values.id,
                  ),
              )
              .map(wire)
              .sort(compare);
          },
        );
        lease.live();
        return result;
      }
      const kind = path.startsWith("customers.") ? "customers" : "contacts",
        list = path.endsWith(".list"),
        data = list ? partial(input ?? {}, ["search"]) : record(input, ["id"]);
      if (list && data.search != null && typeof data.search !== "string")
        throw new InvalidProtectedData();
      const result = await runtime.read([request(kind)], (view) => {
        const values = payloads(view, kind);
        return list
          ? values
              .filter((payload) => payload.row)
              .map(wire)
              .filter((row) => addressMatches(row, data.search))
              .sort(compare)
          : wire(find(values, data.id));
      });
      lease.live();
      return result;
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      lease.live();
      if (!ADDRESS_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const kind: Kind = path.startsWith("customers.")
        ? "customers"
        : "contacts";
      if (path.startsWith("customers.contacts.")) {
        const setting = path.endsWith(".set"),
          removing = path.endsWith(".remove"),
          data = record(input, [
            "customerId",
            setting ? "contactIds" : "contactId",
          ]);
        addressId(data.customerId);
        const ids = setting ? data.contactIds : [data.contactId];
        if (!Array.isArray(ids) || ids.length > 10000)
          throw new InvalidProtectedData();
        const values = [...new Set(ids.map((id) => addressId(id)))];
        await runtime.transaction([customerRequest, contactRequest], (tx) => {
          const original = find(payloads(tx, "customers"), data.customerId),
            contacts = payloads(tx, "contacts");
          if (!removing) for (const id of ids) find(contacts, id);
          const previous = original.links.map(
            (link) => link.values.contact_id as string,
          );
          if (removing && !previous.includes(values[0]!))
            throw new InvalidProtectedData();
          const next = setting
            ? values
            : removing
              ? previous.filter((id) => !values.includes(id))
              : [...new Set([...previous, ...values])];
          tx.edit(
            customerRequest,
            CUSTOMER_COLLECTION.prefix + data.customerId,
            (customer) => {
              customer.links = next.map((contact_id) =>
                decodeBusinessRow({
                  format: "sortsys-row-v2",
                  schema: businessSchema.fingerprint,
                  table: "customer_contacts",
                  values: { customer_id: original.row!.values.id, contact_id },
                }),
              );
            },
          );
        });
        lease.live();
        return { success: true };
      }
      const creating = path.endsWith(".create"),
        deleting = path.endsWith(".delete"),
        data = creating
          ? input
          : record(input, deleting ? ["id"] : ["id", "data"]);
      const selected = request(kind),
        id = creating
          ? publicId(newProductRowId())
          : ((data as Record<string, unknown>).id as string);
      addressId(id);
      const values = deleting
          ? null
          : addressChanges(
              creating ? data : (data as Record<string, unknown>).data,
              kind,
              creating,
            ),
        now = new Date().toISOString();
      if (creating && kind === "customers") {
        const session = await required(
          client.query("auth.sessionInfo", undefined, {
            strategy: "network-only",
          }),
        );
        lease.live();
        values!.created_by_user_id = addressId(session.user.id);
      }
      await runtime.transaction([selected], (tx) => {
        if (deleting) {
          find(payloads(tx, kind), id);
          tx.delete(selected, selected.area.prefix + id);
        } else if (creating) {
          tx.create(selected, selected.area.prefix + id, {
            format: "sortsys-address-v1",
            kind,
            row: decodeBusinessRow({
              format: "sortsys-row-v2",
              schema: businessSchema.fingerprint,
              table: kind,
              values: {
                id: addressId(id),
                ...values,
                created_at: now,
                modified_at: now,
              },
            }),
            links: [],
          });
        } else {
          find(payloads(tx, kind), id);
          tx.patch(
            kind,
            { id: addressId(id) },
            { ...values, modified_at: now },
          );
        }
      });
      lease.live();
      return creating ? { id } : { success: true };
    },
  };
}

export {
  wire as wireAddress,
  compare as compareAddresses,
  partial as partialAddressRecord,
  address as normalizeAddress,
  string as addressText,
};

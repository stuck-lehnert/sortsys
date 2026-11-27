import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { buildPrefixSearch, createPrefixMatcher } from "../search/prefixQuery";
import { ProtectedWriteConflict } from "./atomicWrites";
import type { DuckDriver } from "./database";
import { acquireDataRuntime } from "./runtime/session";
import { defineDataModel } from "./runtime/model";
import type {
  DataCommand,
  DataRequest,
  DataRuntime,
  DataView,
} from "./runtime/runtime";
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
export const ADDRESS_WRITE_ACTIONS = {
  "customers.create": "create",
  "customers.update": "update",
  "customers.delete": "delete",
  "contacts.create": "create",
  "contacts.update": "update",
  "contacts.delete": "delete",
  "customers.contacts.add": "update",
  "customers.contacts.set": "update",
  "customers.contacts.remove": "update",
} as const;
export const ADDRESS_MUTATIONS = new Set(Object.keys(ADDRESS_WRITE_ACTIONS));
type AddressWritePath = keyof typeof ADDRESS_WRITE_ACTIONS;
type AddressWriteResult = { id: string } | { success: true };
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
export function searchableAddressValues(address: Customer["address"]): string[] {
  if (!address) return [];
  // Keep distinct address values in a stable order regardless of JSON key order.
  const values = Object.values(address).filter(
    (value): value is string => typeof value === "string",
  );
  return [...new Set(values)].sort();
}

function addressSearchFields(value: Customer | Contact) {
  return [
    value.salutation,
    ...("name" in value ? [value.name] : [value.firstName, value.lastName]),
    ...searchableAddressValues(value.address),
    ...value.phoneNumbers.map((phone) => phone.number),
    ...value.emailAddresses.map((email) => email.email),
  ];
}
export function createAddressMatcher(search: string | null | undefined) {
  const matches = createPrefixMatcher(search);
  return (value: Customer | Contact) => matches(addressSearchFields(value));
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

function addressObjects(kind: Kind, ids: readonly unknown[]): DataRequest<AddressPayload> {
  const selected = request(kind);
  return {
    ...selected,
    ids: ids.map((id) => selected.area.prefix + publicId(addressId(id))),
  };
}

function selectedAddress(view: DataView, selection: DataRequest<AddressPayload>) {
  const address = view.documents(selection)[0]?.value;
  if (!address?.row) throw new InvalidProtectedData();
  return { ...address, row: address.row };
}

export function readLinkedContacts(
  runtime: DataRuntime,
  parent: DataRequest,
  sequence: string,
  ids: readonly string[],
): Promise<Contact[]> {
  // A verified parent with no links has no contact objects to authorize or read.
  if (ids.length === 0) return Promise.resolve([]);

  const selected = addressObjects("contacts", ids);

  return runtime.read([parent, selected], (view) => {
    // The contact selection belongs to the verified parent head. A changed
    // customer or project cannot use the links chosen by the first read.
    if (view.head(parent).sequence !== sequence)
      throw new ProtectedWriteConflict();

    const contacts: Contact[] = [];
    for (const { value } of view.documents(selected)) {
      if (!value.row) continue;

      const contact = wire(value);
      if ("name" in contact) throw new InvalidProtectedData();
      contacts.push(contact);
    }
    return contacts.sort(compare);
  });
}

const addressSearch = {
  customers: Symbol("customer search"),
  contacts: Symbol("contact search"),
};
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

export function isAddressWrite(path: string): path is AddressWritePath {
  return Object.hasOwn(ADDRESS_WRITE_ACTIONS, path);
}

export function addressWriteRequests(
  path: AddressWritePath,
): readonly [DataRequest<AddressPayload>, ...DataRequest<AddressPayload>[]] {
  if (path.startsWith("customers.contacts.")) {
    return [customerRequest, contactRequest];
  }
  return [path.startsWith("customers.") ? customerRequest : contactRequest];
}

export async function addressBookActor(client: Client): Promise<string> {
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  return addressId(session.user.id);
}

export async function addressBookCommand(
  path: AddressWritePath,
  input: unknown,
  actor: () => Promise<string>,
): Promise<DataCommand<AddressWriteResult>> {
  const action = ADDRESS_WRITE_ACTIONS[path];
  const requests = addressWriteRequests(path);
  const [selected] = requests;

  if (requests.length > 1) {
    const setting = path === "customers.contacts.set";
    const removing = path === "customers.contacts.remove";
    const data = record(input, ["customerId", setting ? "contactIds" : "contactId"]);
    const customerId = addressId(data.customerId);
    const ids = setting ? data.contactIds : [data.contactId];
    if (!Array.isArray(ids) || ids.length > 10000) {
      throw new InvalidProtectedData();
    }
    const values = [...new Set(ids.map(addressId))];
    return {
      requests,
      apply(tx) {
        tx.require(customerRequest, action);
        const original = find(payloads(tx, "customers"), publicId(customerId));
        if (!removing) {
          const contacts = payloads(tx, "contacts");
          for (const id of values) find(contacts, publicId(id));
        }
        const previous = original.links.map((link) => link.values.contact_id as string);
        let next = values;
        if (removing) {
          if (!previous.includes(values[0]!)) throw new InvalidProtectedData();
          next = previous.filter((id) => !values.includes(id));
        } else if (!setting) {
          next = [...new Set([...previous, ...values])];
        }
        tx.edit(
          customerRequest,
          CUSTOMER_COLLECTION.prefix + publicId(customerId),
          (customer) => {
            customer.links = next.map((contact_id) =>
              decodeBusinessRow({
                format: "sortsys-row-v2",
                schema: businessSchema.fingerprint,
                table: "customer_contacts",
                values: { customer_id: customerId, contact_id },
              }),
            );
          },
        );
        return { success: true };
      },
    };
  }

  const kind = selected === customerRequest ? "customers" : "contacts";
  if (action === "create") {
    const values = addressChanges(input, kind, true);
    if (kind === "customers") values.created_by_user_id = await actor();
    const id = newProductRowId();
    const now = new Date().toISOString();
    return {
      requests,
      apply(tx) {
        tx.create(selected, selected.area.prefix + publicId(id), {
          format: "sortsys-address-v1",
          kind,
          row: decodeBusinessRow({
            format: "sortsys-row-v2",
            schema: businessSchema.fingerprint,
            table: kind,
            values: { id, ...values, created_at: now, modified_at: now },
          }),
          links: [],
        });
        return { id: publicId(id) };
      },
    };
  }

  const data = record(input, action === "delete" ? ["id"] : ["id", "data"]);
  const id = addressId(data.id);
  const changes = action === "update" ? addressChanges(data.data, kind, false) : {};
  const now = new Date().toISOString();
  return {
    requests,
    apply(tx) {
      tx.require(selected, action);
      find(payloads(tx, kind), publicId(id));
      if (action === "delete") {
        tx.delete(selected, selected.area.prefix + publicId(id));
      } else {
        tx.patch(kind, { id }, { ...changes, modified_at: now });
      }
      return { success: true };
    },
  };
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
    async query(path: string, input: unknown, limit?: number): Promise<unknown> {
      lease.live();
      if (!ADDRESS_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "customers.contacts.list") {
        const { customerId } = record(input, ["customerId"]);
        const selected = addressObjects("customers", [customerId]);
        const current = await runtime.read([selected], (view) => ({
          sequence: view.head(selected).sequence,
          ids: selectedAddress(view, selected).links.map((link) =>
            publicId(link.values.contact_id),
          ),
        }));
        lease.live();

        const result = await readLinkedContacts(
          runtime,
          selected,
          current.sequence,
          current.ids,
        );
        lease.live();
        return result;
      }

      if (path === "contacts.customers.list") {
        const { contactId } = record(input, ["contactId"]);
        const selected = addressObjects("contacts", [contactId]);
        const result = await runtime.read(
          [selected, customerRequest],
          (view) => {
            const contact = selectedAddress(view, selected);
            return payloads(view, "customers")
              .filter(
                (customer) =>
                  customer.row &&
                  customer.links.some(
                    (link) => link.values.contact_id === contact.row.values.id,
                  ),
              )
              .map(wire)
              .sort(compare);
          },
        );
        lease.live();
        return result;
      }
      const kind = path.startsWith("customers.") ? "customers" : "contacts";
      if (path.endsWith(".get")) {
        const { id } = record(input, ["id"]);
        const selected = addressObjects(kind, [id]);
        const result = await runtime.read([selected], (view) =>
          wire(selectedAddress(view, selected)),
        );
        lease.live();
        return result;
      }

      const data = partial(input ?? {}, ["search"]);
      if (data.search != null && typeof data.search !== "string")
        throw new InvalidProtectedData();

      const selected = [request(kind)];
      const result = await runtime.read(
        selected,
        (view) => {
          const search = view.derive(addressSearch[kind], selected, () =>
            buildPrefixSearch(
              payloads(view, kind)
                .filter((payload) => payload.row)
                .map(wire)
                .sort(compare),
              addressSearchFields,
            ),
          );
          return search(data.search as string | undefined, undefined, limit);
        },
        undefined,
        { batchDirectory: limit !== undefined },
      );
      lease.live();
      return result;
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      lease.live();
      if (!isAddressWrite(path)) throw new InvalidProtectedData();
      const command = await addressBookCommand(path, input, () =>
        addressBookActor(client),
      );
      lease.live();
      const result = await runtime.transaction(command.requests, command.apply);
      lease.live();
      return result;
    },
  };
}

export {
  partial as partialAddressRecord,
  address as normalizeAddress,
  string as addressText,
};

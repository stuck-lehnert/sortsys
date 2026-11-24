import { expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import {
  addressChanges,
  addressId,
  addressPayload,
  CONTACT_COLLECTION,
  createAddressMatcher,
  createProtectedAddressBook,
  CUSTOMER_COLLECTION,
} from "./addressBook";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

function customer() { return { format: "sortsys-address-v1", kind: "customers", row: row("customers", {
  id: "100", name: "Bauherr", phone_numbers: "[]", email_addresses: "[]",
}), links: [row("customer_contacts", { customer_id: "100", contact_id: "101" })] }; }

test("address objects bind their table, identity, links and schema without exposing another facet", () => {
  const value = customer();
  expect(addressPayload(value, "customer:34", "customers").links.length).toBe(1);
  for (const changed of [{ ...value, row: { ...value.row, values: { ...value.row.values, salary: "100" } } },
    { ...value, links: [row("customer_contacts", { customer_id: "102", contact_id: "101" })] },
    { ...value, links: [...value.links, ...value.links] }, { ...value, kind: "contacts" }, { ...value, row: null }]) {
    expect(() => addressPayload(changed, "customer:34", "customers")).toThrow();
  }
  expect(() => addressPayload(value, "contact:34", "customers")).toThrow();
  expect(() => addressPayload({ ...value, row: { ...value.row, values: { ...value.row.values, email_addresses: '[{"email":"missing-at"}]' } } }, "customer:34", "customers")).toThrow();
  expect(addressPayload({ format: value.format, kind: "customers", row: null, links: [] }, "customer:34", "customers").row).toBeNull();
  expect(addressId("7vvvvvvvvvvvv")).toBe("9223372036854775807");
  for (const id of ["0", "034", "8000000000000", "ABC", "-1"]) expect(() => addressId(id)).toThrow();
});

test("address edits preserve absent patch fields and normalize new names and channels", () => {
  expect(addressChanges({ name: "  Musterbau  ", phoneNumbers: [{ number: " +49 123 ", name: " Büro " }] }, "customers", false))
    .toEqual({ name: "Musterbau", phone_numbers: '[{"number":"+49 123","name":"Büro"}]' });
  expect(addressChanges({ firstName: null }, "contacts", false)).toEqual({ first_name: null });
  for (const input of [{}, { unknown: "extra" }, { address: { city: "Nürnberg" } }, { phoneNumbers: null }, { emailAddresses: [{ email: "bad" }] }]) {
    expect(() => addressChanges(input, "customers", false)).toThrow();
  }
});

test("local address search matches actual address and channel values, never JSON field names or timestamps", () => {
  const value = { name: "Musterbau", salutation: "Firma", address: { city: "Nürnberg", streetAddress: "Pirckheimer Straße" },
    phoneNumbers: [{ number: "+49 12345", name: "Durchwahl" }], emailAddresses: [{ email: "bauleitung@muster.example" }], createdAt: new Date("2026-11-09"), id: "34" };
  for (const search of ["Nürn Pirck", "bauleitung", "12345"])
    expect(createAddressMatcher(search)(value)).toBe(true);
  for (const search of ["createdAt", "phoneNumbers", "2026", "Durchwahl", "Hamburg"])
    expect(createAddressMatcher(search)(value)).toBe(false);
});

function objectReads(calls) {
  return calls.flatMap(({ path, input }) => {
    if (path === "zerotrust.objects.get") return [input.id];
    if (path === "zerotrust.objects.getMany") return input.ids;
    return [];
  });
}

function fullPages(calls) {
  const selections = calls.flatMap(({ path, input }) => {
    if (path === "zerotrust.objects.list") return [input];
    if (path === "zerotrust.objects.pages") return input.selections;
    if (path.startsWith("zerotrust.access.")) return input.pages?.selections ?? [];
    return [];
  });

  return selections.filter((page) => !page.headOnly);
}

test("address details and forward links open only the selected objects", async () => {
  const customerArea = CUSTOMER_COLLECTION;
  const contactArea = CONTACT_COLLECTION;
  const { client, seed, calls } = await protectedTenant(
    [customerArea, contactArea],
    () => ["read"],
  );
  const store = createProtectedAddressBook(client, new AbortController().signal, duckDriver);

  const contact = {
    format: "sortsys-address-v1",
    kind: "contacts",
    row: row("contacts", {
      id: "101",
      last_name: "Muster",
      phone_numbers: '[{"number":"+49 12345","name":null}]',
      email_addresses: '[{"email":"office@example.test","name":"Büro"}]',
    }),
    links: [],
  };

  try {
    await seed(customerArea, "customer:34", customer());
    await seed(contactArea, "contact:35", contact);
    await seed(contactArea, "contact:36", { ...contact, row: null });

    expect(await store.query("customers.get", { id: "34" })).toMatchObject({
      id: "34",
      name: "Bauherr",
    });
    expect(await store.query("contacts.get", { id: "35" })).toMatchObject({
      id: "35",
      lastName: "Muster",
      phoneNumbers: [{ number: "+49 12345", name: null }],
      emailAddresses: [{ email: "office@example.test", name: "Büro" }],
    });
    for (const id of ["36", "37", "035"]) {
      await expect(store.query("contacts.get", { id })).rejects.toThrow();
    }

    expect(fullPages(calls)).toEqual([]);
    expect(objectReads(calls)).toEqual([
      "customer:34",
      "contact:35",
      "contact:36",
      "contact:37",
    ]);

    await store.refresh();
    const linkStart = calls.length;
    expect(await store.query("customers.contacts.list", { customerId: "34" }))
      .toMatchObject([{ id: "35", lastName: "Muster" }]);

    const linkCalls = calls.slice(linkStart);
    expect(new Set(objectReads(linkCalls))).toEqual(new Set(["customer:34", "contact:35"]));
    expect(fullPages(linkCalls)).toEqual([]);

    expect(await store.query("contacts.customers.list", { contactId: "35" }))
      .toMatchObject([{ id: "34", name: "Bauherr" }]);
  } finally {
    store.close();
    lockCryptoSession();
  }
}, fixtureTimeout(30_000));

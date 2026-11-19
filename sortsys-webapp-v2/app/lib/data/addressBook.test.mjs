import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { addressChanges, addressId, createAddressMatcher, addressPayload } from "./addressBook";

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

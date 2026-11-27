import { expect, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
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
import { projectCollection } from "./projectData";
import { createProtectedProjects } from "./projects";
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

test("write references verify only selected contacts at the current catalog head", async () => {
  const area = CONTACT_COLLECTION;
  const { client, seed, calls, domains } = await protectedTenant(
    [area],
    () => ["read"],
  );
  const store = createProtectedAddressBook(client, new AbortController().signal, duckDriver);
  const contact = (id) => ({
    format: "sortsys-address-v1",
    kind: "contacts",
    row: row("contacts", {
      id,
      last_name: `Kontakt ${id}`,
      phone_numbers: "[]",
      email_addresses: "[]",
    }),
    links: [],
  });

  try {
    await seed(area, "contact:35", contact("101"));
    await seed(area, "contact:36", contact("102"));
    await seed(area, "contact:37", contact("103"));

    expect(await store.references("contacts", ["35", "36", "35"])).toEqual({
      domain: area.domain,
      sequence: String(domains.get(area.domain).head),
    });
    expect(objectReads(calls).sort()).toEqual(["contact:35", "contact:36"]);
    expect(fullPages(calls)).toEqual([]);

    const next = calls.length;
    await seed(area, "contact:36", { ...contact("102"), row: null });
    await expect(store.references("contacts", ["35", "36"])).rejects.toThrow();
    await expect(store.references("contacts", ["38"])).rejects.toThrow();
    expect(await store.references("contacts", ["35"])).toEqual({
      domain: area.domain,
      sequence: String(domains.get(area.domain).head),
    });
    expect(objectReads(calls.slice(next))).not.toContain("contact:37");
    expect(fullPages(calls.slice(next))).toEqual([]);
  } finally {
    store.close();
    lockCryptoSession();
  }
}, fixtureTimeout(30_000));

test("unlinked projects and customers read their parent but do not open the contact area", async () => {
  const projectArea = projectCollection("2");
  const { client, seed, calls } = await protectedTenant(
    [projectArea, CUSTOMER_COLLECTION, CONTACT_COLLECTION],
    () => ["read"],
  );
  const signal = new AbortController().signal;
  const directory = createProtectedAddressBook(client, signal, duckDriver);
  const projects = createProtectedProjects(
    client,
    signal,
    async () => directory,
    duckDriver,
  );

  try {
    await seed(CUSTOMER_COLLECTION, "customer:34", { ...customer(), links: [] });
    await seed(projectArea, projectArea.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Sanierung" }),
      contacts: [],
    });

    const queries = [
      {
        area: CUSTOMER_COLLECTION,
        list: () =>
          directory.query("customers.contacts.list", { customerId: "34" }),
      },
      {
        area: projectArea,
        list: () =>
          projects.query("projects.contacts.list", { projectId: "2" }),
      },
    ];
    for (const { area, list } of queries) {
      const start = calls.length;
      expect(await list()).toEqual([]);

      const reads = calls.slice(start);
      const snapshots = reads.filter(
        ({ path }) => path === "zerotrust.access.snapshot",
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].input.domains).toContain(area.domain);
      expect(snapshots[0].input.domains).not.toContain(CONTACT_COLLECTION.domain);

      const accessedContacts = objectReads(reads).filter((id) =>
        id.startsWith(CONTACT_COLLECTION.prefix),
      );
      expect(accessedContacts).toEqual([]);
    }
  } finally {
    projects.close();
    directory.close();
    lockCryptoSession();
  }
}, fixtureTimeout(30_000));

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
    for (const id of ["36", "37"]) {
      await expect(store.query("contacts.get", { id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    await expect(store.query("contacts.get", { id: "035" }))
      .rejects.toBeInstanceOf(InvalidProtectedData);

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

    await seed(customerArea, "customer:34", { ...customer(), row: null, links: [] });
    await store.refresh();
    await expect(store.query("customers.get", { id: "34" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    store.close();
    lockCryptoSession();
  }
}, fixtureTimeout(30_000));

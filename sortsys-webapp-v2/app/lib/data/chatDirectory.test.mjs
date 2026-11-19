import { expect, test } from "bun:test";
import { CONTACT_COLLECTION, CUSTOMER_COLLECTION } from "./addressBook";
import { chatDirectoryPaths, searchAssistantDirectory } from "./chatDirectory";
import { projectCollection } from "./projectData";

function access(...areas) {
  const domains = areas.map(({ domain }) => ({ id: domain }));
  const grants = new Set(domains.map(({ id }) => id));
  return { domains, canRead: ({ domain }) => grants.has(domain) };
}

test("directory joins are available only with both signed sources", () => {
  expect(chatDirectoryPaths(access(CUSTOMER_COLLECTION, projectCollection("7"))))
    .toEqual(["customers.list", "customers.get"]);
  expect(chatDirectoryPaths(access(CONTACT_COLLECTION, projectCollection("7"))))
    .toEqual(["contacts.list", "contacts.get", "projects.contacts.list", "contacts.projects.list"]);
  expect(chatDirectoryPaths(access(CONTACT_COLLECTION, CUSTOMER_COLLECTION)))
    .toContain("customers.contacts.list");
});

test("compact customer search preserves bounded address-book matches and omits unrelated fields", async () => {
  const signal = new AbortController().signal;
  const lookup = async (path, query, cancellation, limit) => {
    expect([path, query, cancellation, limit]).toEqual(["customers.list", "+49911", signal, 2]);
    return [{ id: "4", name: "Bauamt", address: null, createdByUserId: "1" }];
  };
  const rows = await searchAssistantDirectory(
    lookup, "customers.list", "+49911", 2, signal, access(CUSTOMER_COLLECTION),
  );
  expect(rows).toEqual([{ id: "4", name: "Bauamt", address: null }]);
  await expect(searchAssistantDirectory(
    lookup, "customers.list", "+49911", 2, signal, access(CONTACT_COLLECTION),
  )).rejects.toThrow();
});

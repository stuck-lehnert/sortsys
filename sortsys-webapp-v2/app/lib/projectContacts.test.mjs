import { describe, expect, test } from "bun:test";
import { projectContactsEqual } from "./projectContacts";

describe("project contact changes", () => {
  const contacts = [
    { contactId: "alex", label: "Bauleitung" },
    { contactId: "sam", label: null },
  ];

  test("ignores row order and normalized empty labels", () => {
    expect(projectContactsEqual(contacts, [
      { contactId: "sam", label: " " },
      { contactId: "alex", label: " Bauleitung " },
    ])).toBe(true);
    expect(projectContactsEqual([], [])).toBe(true);
  });

  test("detects additions and removals", () => {
    expect(projectContactsEqual(contacts, contacts.slice(0, 1))).toBe(false);
    expect(projectContactsEqual(contacts, [...contacts, { contactId: "kim" }])).toBe(false);
    expect(projectContactsEqual(contacts, [])).toBe(false);
  });

  test("detects label edits and contact replacements", () => {
    expect(projectContactsEqual(contacts, [
      { contactId: "alex", label: "Architekt" },
      { contactId: "sam" },
    ])).toBe(false);
    expect(projectContactsEqual(contacts, [
      { contactId: "kim", label: "Bauleitung" },
      { contactId: "sam" },
    ])).toBe(false);
  });

  test("matches the server's duplicate-ID behavior", () => {
    expect(projectContactsEqual(contacts, [
      { contactId: "alex", label: "Old label" },
      { contactId: "sam" },
      { contactId: "alex", label: "Bauleitung" },
    ])).toBe(true);
  });
});


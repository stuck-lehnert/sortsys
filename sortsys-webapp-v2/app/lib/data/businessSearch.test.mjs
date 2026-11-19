import { expect, test } from "bun:test";
import { createAddressMatcher } from "./addressBook";
import { createProjectMatcher } from "./projectData";

const address = {
  streetAddress: "Pirckheimer-Straße 18",
  city: "Nürnberg",
  country: "DE",
  zip: "90403",
};
const channels = {
  phoneNumbers: [{ number: "+49 911 4123", name: "Durchwahl" }],
  emailAddresses: [{ email: "Bauleitung.West@beispiel.de", name: "Objektleitung" }],
};
const project = { title: "Fenstersanierung", address };
const customer = {
  name: "Musterbau-Nord",
  salutation: "Firma",
  address,
  ...channels,
};
const contact = {
  firstName: "Klara",
  lastName: "Bauleitung",
  salutation: "Frau",
  address,
  ...channels,
};

// Reference results of create_query and each table's search vector on PostgreSQL 18.6.
const cases = [
  ["Pirckheimer-Str", ["project", "customer", "contact"]],
  ["Straße-Pirckheimer", []],
  ["Straße Pirckheimer", ["project", "customer", "contact"]],
  ["Nürn Pirck", ["project", "customer", "contact"]],
  ["Nürnberg-Pirckheimer", []],
  ["18", ["project", "customer", "contact"]],
  ["18–22", []],
  ["90403 DE", ["project", "customer", "contact"]],
  ["zip", []],
  ["Fir Musterbau", ["customer"]],
  ["Musterbau-Nor", ["customer"]],
  ["Nord-Musterbau", []],
  ["Bauleitung.West@bei", []],
  ["bauleitung", ["customer", "contact"]],
  ["beispiel.de", []],
  ["West", []],
  ["Objektleitung", []],
  ["Durchwahl", []],
  ["+49", ["customer", "contact"]],
  ["911 41", ["customer", "contact"]],
  ["49", []],
  ["+49-911", []],
  ["49 91", []],
  ["...", []],
];

test.each(cases)("matches legacy project and address search for %j", (search, expected) => {
  const matchesAddress = createAddressMatcher(search);
  const hits = [];
  if (createProjectMatcher(search)(project)) hits.push("project");
  if (matchesAddress(customer)) hits.push("customer");
  if (matchesAddress(contact)) hits.push("contact");
  expect(hits).toEqual(expected);
});

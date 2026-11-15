import { expect, test } from "bun:test";
import { sessionUser } from "./sessionUser";
import { userContractName } from "./format";

const account = { id: "4", username: "anna.muster", locale: "en" };
const profile = {
  ...account,
  firstName: "Anna",
  lastName: "Muster",
  salutation: "Frau",
  email: "anna@example.invalid",
  phone: "091112345",
  contractType: "external",
  costPerHour: 89.875,
  vacationDaysPerYear: 30,
};

test("technical account metadata never masquerades as a decrypted personnel profile", () => {
  const fallback = sessionUser({
    ...account,
    firstName: "Old server name",
    email: "old@example.invalid",
    contractType: "internal",
  });
  expect(fallback).toEqual({
    ...account,
    firstName: account.username,
    lastName: null,
    salutation: null,
    email: null,
    phone: null,
    contractType: null,
  });
});

test("a private display profile retains the authenticated identity and excludes payroll fields", () => {
  expect(sessionUser(account, profile)).toEqual({
    ...account,
    firstName: "Anna",
    lastName: "Muster",
    salutation: "Frau",
    email: profile.email,
    phone: profile.phone,
    contractType: "external",
  });
  expect(Object.hasOwn(sessionUser(account, profile), "costPerHour")).toBe(
    false,
  );
  expect(
    Object.hasOwn(sessionUser(account, profile), "vacationDaysPerYear"),
  ).toBe(false);
});

test("another person's profile or an old username cannot populate the current session", () => {
  for (const changed of [{ id: "5" }, { username: "other" }])
    expect(sessionUser(account, { ...profile, ...changed })).toEqual(
      sessionUser(account),
    );
});

test("an unavailable employment classification is not presented as an internal employee", () => {
  expect(userContractName(sessionUser(account))).toBe("—");
  expect(userContractName(sessionUser(account, profile))).toBe("Extern");
});

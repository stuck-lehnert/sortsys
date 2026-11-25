import { expect, test } from "bun:test";
import {
  organizationProfile,
  organizationNumbering,
  organizationPayload,
  organizationObject,
} from "./organizationData";
import { organizationSource } from "./migrateOrganization";

test("organization settings validate complete addresses without accepting arbitrary fields", () => {
  const profile = {
    companyName: "Musterbau GmbH",
    address: {
      streetAddress: "Bauweg 7",
      city: "Nürnberg",
      zip: "90408",
      country: "DE",
    },
  };
  expect(organizationProfile(profile, true)).toEqual(profile);
  expect(organizationProfile({ companyName: null, address: null })).toEqual({
    companyName: null,
    address: null,
  });
  expect(
    organizationProfile({ ...profile, companyName: " Musterbau GmbH " }, true)
      .companyName,
  ).toBe("Musterbau GmbH");
  for (const bad of [
    { ...profile, arbitrary: "extra" },
    { ...profile, companyName: "" },
    { ...profile, companyName: "ü".repeat(61) },
    { ...profile, companyName: "A\0B" },
    { ...profile, address: { ...profile.address, city: " " } },
    { ...profile, address: { ...profile.address, latitude: 1 } },
    { ...profile, address: { streetAddress: "Bauweg", city: "Nürnberg" } },
  ]) {
    expect(() => organizationProfile(bad, true)).toThrow();
  }
});

test("all invoice schemes keep counters exact through the signed int64 limit", () => {
  for (const scheme of [
    "sequential",
    "dateSeparated",
    "dateCompact",
    "projectLocal",
    "projectGlobal",
  ]) {
    expect(
      organizationNumbering({ scheme, startNumber: "9223372036854775807" }),
    ).toEqual({ scheme, startNumber: "9223372036854775807" });
  }
  expect(
    organizationNumbering({ scheme: "sequential", startNumber: " 00023 " })
      .startNumber,
  ).toBe("23");
  for (const startNumber of [
    "0",
    "-1",
    "1e3",
    "1.0",
    "9223372036854775808",
    3,
    null,
    " ",
  ]) {
    expect(() =>
      organizationNumbering({ scheme: "sequential", startNumber }),
    ).toThrow();
  }
  expect(() =>
    organizationNumbering({ scheme: "unknown", startNumber: "1" }),
  ).toThrow();
  expect(() =>
    organizationNumbering({ scheme: ["sequential"], startNumber: "1" }),
  ).toThrow();
  expect(() =>
    organizationNumbering({
      scheme: "sequential",
      startNumber: "1",
      counter: "secret",
    }),
  ).toThrow();
});

test("organization records cannot cross profiles, billing scopes or object bindings", () => {
  const payload = {
    format: "sortsys-organization-v1",
    kind: "profile",
    value: { companyName: null, address: null },
  };
  expect(
    organizationPayload(payload, organizationObject("profile"), "profile"),
  ).toEqual(payload);
  expect(() =>
    organizationPayload(payload, organizationObject("numbering"), "profile"),
  ).toThrow();
  expect(() =>
    organizationPayload(payload, organizationObject("numbering"), "numbering"),
  ).toThrow();
  expect(() =>
    organizationPayload(
      { ...payload, extra: true },
      organizationObject("profile"),
      "profile",
    ),
  ).toThrow();
  expect(() =>
    organizationPayload(
      { ...payload, value: { companyName: "A" } },
      organizationObject("profile"),
      "profile",
    ),
  ).toThrow();
});

test("organization conversion uses the archived contact record and legacy defaults", () => {
  const source = {
    values: {
      key: "sortsys.legacy.organization.archive-1",
      name: JSON.stringify({
        companyName: "Bau GmbH",
        address: {
          streetAddress: "Bauweg 1",
          city: "Nürnberg",
          zip: "90408",
        },
        unrelatedLegacyField: "remains in the archive",
      }),
    },
  };
  const before = JSON.stringify(source);
  expect(organizationSource([source]).map((row) => row.value)).toEqual([
    {
      companyName: "Bau GmbH",
      address: {
        streetAddress: "Bauweg 1",
        city: "Nürnberg",
        zip: "90408",
        country: null,
      },
    },
    { scheme: "sequential", startNumber: "1" },
    { scheme: "sequential", startNumber: "1" },
  ]);
  expect(JSON.stringify(source)).toBe(before);
  const offers = {
    values: {
      key: "organization.offerNumbering",
      name: '{"scheme":"dateCompact","startNumber":"9223372036854775807"}',
    },
  };
  expect(organizationSource([source, offers])[2].value).toEqual({
    scheme: "dateCompact",
    startNumber: "9223372036854775807",
  });
  const numbering = {
    values: { key: "organization.invoiceNumbering", name: null },
  };
  expect(organizationSource([source, numbering])[1].value).toEqual({
    scheme: "sequential",
    startNumber: "1",
  });
  numbering.values.name = JSON.stringify({
    scheme: "projectGlobal",
    startNumber: "1234567890123456789",
  });
  expect(organizationSource([source, numbering])[1].value).toEqual({
    scheme: "projectGlobal",
    startNumber: "1234567890123456789",
  });
  expect(() => organizationSource([])).toThrow();
  expect(() => organizationSource([source, source])).toThrow();
  numbering.values.name = JSON.stringify({
    scheme: "projectGlobal",
    startNumber: 123,
  });
  expect(() => organizationSource([source, numbering])).toThrow();
});

test("archived supervisor settings retain exact IDs and reject malformed or duplicate source records", async () => {
  const { supervisorSettingsFromBackup } =
    await import("./migrateOrganization");
  const id = "9223372036854775807";
  const setting = {
    values: { key: "users.defaultSupervisorUserId", name: JSON.stringify(id) },
  };
  const people = [{ values: { id } }];
  expect(supervisorSettingsFromBackup([setting], people)).toEqual({
    format: "sortsys-supervisor-settings-v1",
    userId: BigInt(id).toString(32),
  });
  expect(supervisorSettingsFromBackup([], people)).toBeNull();
  expect(supervisorSettingsFromBackup([setting], [])).toEqual({
    format: "sortsys-supervisor-settings-v1",
    userId: null,
  });
  expect(
    supervisorSettingsFromBackup(
      [{ values: { ...setting.values, name: null } }],
      people,
    )?.userId,
  ).toBeNull();
  expect(() =>
    supervisorSettingsFromBackup([setting, setting], people),
  ).toThrow();
  for (const name of [
    "invalid JSON",
    JSON.stringify(42),
    JSON.stringify("1e3"),
    JSON.stringify("0"),
    JSON.stringify("9223372036854775808"),
  ]) {
    expect(() =>
      supervisorSettingsFromBackup(
        [{ values: { ...setting.values, name } }],
        people,
      ),
    ).toThrow();
  }
});

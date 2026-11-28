import { afterEach, expect, test } from "bun:test";
import { ACTIONS, compilePolicy } from "@sortsys/zerotrust/sortsys";
import {
  absenceDefaultRules,
  synchronizeAbsenceDefaults,
} from "../crypto/absenceDefaults";
import { lockCryptoSession } from "../crypto/session";
import { absenceCollection } from "./absenceData";
import {
  ORGANIZATION_AREAS,
  ORGANIZATION_COLLECTION,
} from "./organizationData";
import { prepareOrganization } from "./migrateOrganization";
import { createBusinessDatabase } from "./database";
import { projectCompleteRows } from "./projection";
import { personnelCollection, personnelPart } from "./personnelData";
import { createProtectedPersonnel } from "./personnel";
import { createProtectedSupervisorSettings } from "./supervisorSettings";
import {
  supervisorSettingsRequest,
  SUPERVISOR_SETTINGS_ID,
} from "./supervisorSettingsData";
import { row } from "./rowCodec.test.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

const people = [
  { id: "1", contractType: "internal", supervisorUserId: null },
  { id: "2", contractType: "internal", supervisorUserId: null },
  { id: "3", contractType: "internal", supervisorUserId: "2" },
  { id: "4", contractType: "external", supervisorUserId: null },
];

function permissions(fallback) {
  return {
    tenant: "test",
    version: "1",
    suspended: [],
    rules: absenceDefaultRules(
      people,
      new Set(people.map((person) => person.id)),
      fallback,
    ),
  };
}

test("the fallback controls unassigned staff without replacing an explicit supervisor", () => {
  const policy = permissions("1");
  const owner = compilePolicy(policy, ["user:1"]);
  const employee = compilePolicy(policy, ["user:2"]);
  expect(owner.allows("absence:2", "personnel", "approve")).toBe(true);
  expect(employee.allows("absence:2", "personnel", "approve")).toBe(false);
  expect(employee.allows("absence:3", "personnel", "approve")).toBe(true);
  expect(owner.allows("absence:3", "personnel", "approve")).toBe(false);
  expect(owner.allows("absence:1", "personnel", "approve")).toBe(true);
  expect(
    compilePolicy(policy, ["user:4"]).allows(
      "absence:4",
      "personnel",
      "approve",
    ),
  ).toBe(true);
  expect(
    compilePolicy(permissions(null), ["user:2"]).allows(
      "absence:2",
      "personnel",
      "approve",
    ),
  ).toBe(true);
});

test("a missing fallback target or a cycle through its explicit ancestors is rejected", () => {
  expect(() => permissions("7")).toThrow();
  const cyclic = people.map((person) =>
    person.id === "1" ? { ...person, supervisorUserId: "2" } : person,
  );
  expect(() => absenceDefaultRules(cyclic, new Set(["1", "2"]), "1")).toThrow();
});

async function fixture(organizationWrite = true) {
  const profiles = people.slice(0, 3);
  const areas = [
    ORGANIZATION_COLLECTION,
    ...profiles.flatMap((person) => [
      personnelCollection(person.id, "master-data"),
      personnelCollection(person.id, "scope"),
      absenceCollection(person.id),
      absenceCollection(person.id, true),
    ]),
  ];
  const tenant = await protectedTenant(areas, (area) => {
    if (area.domain === ORGANIZATION_COLLECTION.domain && !organizationWrite)
      return ["read"];
    return [...ACTIONS];
  });
  tenant.state.roles = [":admin"];
  for (const person of profiles) {
    const value = row("users", {
      id: person.id,
      username: person.id === "1" ? "owner" : `person${person.id}`,
      first_name: `Person ${person.id}`,
      ui_locale: "de",
      contract_type: person.contractType,
      supervisor_user_id: person.supervisorUserId,
    });
    for (const facet of ["master-data", "scope"]) {
      const area = personnelCollection(person.id, facet);
      await tenant.seed(area, area.prefix, personnelPart(value, facet));
    }
  }
  const signal = new AbortController().signal;
  await synchronizeAbsenceDefaults(tenant.client, signal, duckDriver);
  return {
    ...tenant,
    signal,
    store: createProtectedSupervisorSettings(tenant.client, signal, duckDriver),
  };
}

test("an encrypted fallback and its signature-bound policy publish together, including after a lost reply", async () => {
  const tenant = await fixture();
  try {
    expect(await tenant.store.query("users.supervisors.getDefault")).toEqual({
      userId: null,
    });
    const [before] = await tenant.client.query("zerotrust.policy.get");
    tenant.state.loseReply = true;
    await tenant.store.mutate("users.supervisors.setDefault", { userId: "1" });
    expect(await tenant.store.query("users.supervisors.getDefault")).toEqual({
      userId: "1",
    });
    const batch = tenant.calls
      .filter((call) => call.path === "zerotrust.objects.batch")
      .at(-1).input;
    expect(batch.objects).toHaveLength(1);
    expect(batch.objects[0].domain).toBe(ORGANIZATION_COLLECTION.domain);
    expect(batch.policy.transaction.previousSignature).toBe(before.signature);
    expect(batch.policy.transaction.packets).toEqual([
      batch.objects[0].envelope.signature,
    ]);
    expect(
      batch.heads.some(
        (head) => head.domain === ORGANIZATION_COLLECTION.domain,
      ),
    ).toBe(true);
    expect(JSON.stringify(batch)).not.toContain(
      "sortsys-supervisor-settings-v1",
    );
    const [policy] = await tenant.client.query("zerotrust.policy.get");
    expect(policy.signature).toBe(batch.policy.signature);
    expect(
      policy.rules.some(
        (rule) =>
          rule.origin === "absence-default" &&
          rule.scope === "absence:2" &&
          rule.subject === "user:1" &&
          rule.actions.includes("approve"),
      ),
    ).toBe(true);
    await tenant.store.mutate("users.supervisors.setDefault", { userId: null });
    expect(await tenant.store.query("users.supervisors.getDefault")).toEqual({
      userId: null,
    });
    const [cleared] = await tenant.client.query("zerotrust.policy.get");
    expect(
      cleared.rules.some(
        (rule) =>
          rule.origin === "absence-default" &&
          rule.scope === "absence:2" &&
          rule.subject === "user:1",
      ),
    ).toBe(false);
  } finally {
    tenant.store.close();
  }
}, 30000);

test("a stale personnel prerequisite or a false success cannot publish half of a fallback change", async () => {
  const tenant = await fixture();
  try {
    const [before] = await tenant.client.query("zerotrust.policy.get");
    let conflict = true;
    tenant.state.beforeCommit = async () => {
      if (conflict) {
        conflict = false;
        tenant.domains.get(personnelCollection("2", "scope").domain).head++;
      }
    };
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: "1" }),
    ).rejects.toThrow();
    expect(tenant.objects.has(SUPERVISOR_SETTINGS_ID)).toBe(false);
    expect(
      (await tenant.client.query("zerotrust.policy.get"))[0].signature,
    ).toBe(before.signature);
    tenant.state.discardCommit = true;
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: "1" }),
    ).rejects.toThrow();
    expect(tenant.objects.has(SUPERVISOR_SETTINGS_ID)).toBe(false);
    expect(
      (await tenant.client.query("zerotrust.policy.get"))[0].signature,
    ).toBe(before.signature);
  } finally {
    tenant.store.close();
  }
}, 30000);

test("ordinary roles, unknown people and malformed settings cannot change the fallback", async () => {
  const tenant = await fixture();
  try {
    tenant.state.roles = [];
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: "1" }),
    ).rejects.toThrow();
    tenant.state.roles = [":admin"];
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: "7" }),
    ).rejects.toThrow();
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", {
        userId: "1",
        extra: true,
      }),
    ).rejects.toThrow();
    expect(tenant.objects.has(SUPERVISOR_SETTINGS_ID)).toBe(false);
    await tenant.seed(supervisorSettingsRequest.area, SUPERVISOR_SETTINGS_ID, {
      format: "sortsys-supervisor-settings-v1",
      userId: "1",
      hidden: "unexpected field",
    });
    await tenant.store.refresh();
    await expect(
      tenant.store.query("users.supervisors.getDefault"),
    ).rejects.toThrow();
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: null }),
    ).rejects.toThrow();
  } finally {
    tenant.store.close();
  }
}, 30000);

test("supervisor choices keep all names in order without opening private personnel facets", async () => {
  const tenant = await fixture();
  const personnel = createProtectedPersonnel(
    tenant.client,
    tenant.signal,
    duckDriver,
  );
  const scope = personnelCollection("3", "scope").domain;
  const master = personnelCollection("3", "master-data").domain;

  function listed(calls, domain) {
    return calls.some(({ path, input }) => {
      switch (path) {
        case "zerotrust.objects.list":
          return input.domain === domain;
        case "zerotrust.objects.pages":
          return input.selections.some((page) => page.domain === domain);
        case "zerotrust.access.snapshot":
          return input.pages?.selections.some((page) => page.domain === domain);
        default:
          return false;
      }
    });
  }

  const labels = (users) => users.map(({ id, firstName, lastName }) => ({
    id,
    firstName,
    lastName,
  }));

  try {
    const start = tenant.calls.length;
    const choices = await personnel.query("users.supervisors.choices");
    const choiceCalls = tenant.calls.slice(start);
    expect(listed(choiceCalls, master)).toBe(true);
    expect(listed(choiceCalls, scope)).toBe(false);
    expect(choices.find(({ id }) => id === "3").supervisorUserId).toBeNull();

    const listStart = tenant.calls.length;
    const rows = await personnel.query("users.list", {});
    expect(listed(tenant.calls.slice(listStart), scope)).toBe(true);
    expect(rows.find(({ id }) => id === "3").supervisorUserId).toBe("2");

    expect(labels(choices)).toEqual(labels(rows));
    expect(choices).toHaveLength(3);
  } finally {
    personnel.close();
    tenant.store.close();
  }
}, 120000);

test("an administrative role cannot bypass the encrypted organization's write permission", async () => {
  const tenant = await fixture(false);
  try {
    expect(await tenant.store.query("users.supervisors.getDefault")).toEqual({
      userId: null,
    });
    await expect(
      tenant.store.mutate("users.supervisors.setDefault", { userId: "1" }),
    ).rejects.toThrow();
    expect(tenant.objects.has(SUPERVISOR_SETTINGS_ID)).toBe(false);
  } finally {
    tenant.store.close();
  }
}, 30000);

test("opening one personnel profile reads its facets without searching the catalogue", async () => {
  const tenant = await fixture();
  const calls = [];
  const transport = {
    ...tenant.client,
    query(path, input, options) {
      calls.push({ path, input });
      return tenant.client.query(path, input, options);
    },
  };
  const personnel = createProtectedPersonnel(transport, tenant.signal, duckDriver);
  try {
    const profile = await personnel.query("users.get", { id: "3" });
    expect(profile.firstName).toBe("Person 3");
    expect(profile.supervisorUserId).toBe("2");

    const catalogueReads = calls.filter(({ path }) =>
      ["zerotrust.access.page", "zerotrust.domains.list"].includes(path),
    );
    expect(catalogueReads).toEqual([]);
    const inventories = calls.filter(
      ({ path }) => path === "zerotrust.access.snapshot",
    );
    expect(inventories.length).toBeGreaterThan(0);
    for (const { input } of inventories) {
      expect(input.domains.length).toBeGreaterThan(0);
      expect(
        input.domains.every((domain) => /^personnel:(1|3):/.test(domain)),
      ).toBe(true);
    }
  } finally {
    personnel.close();
    tenant.store.close();
  }
}, 30000);

test("later personnel changes retain the configured fallback as a guarded prerequisite", async () => {
  const tenant = await fixture();
  const personnel = createProtectedPersonnel(
    tenant.client,
    tenant.signal,
    duckDriver,
  );
  try {
    await tenant.store.mutate("users.supervisors.setDefault", { userId: "1" });
    await personnel.mutate("users.update", {
      id: "2",
      data: { contractType: "external" },
    });
    const batch = tenant.calls
      .filter((call) => call.path === "zerotrust.objects.batch")
      .at(-1).input;
    expect(
      batch.heads.some(
        (head) => head.domain === ORGANIZATION_COLLECTION.domain,
      ),
    ).toBe(true);
    expect(batch.policy).toBeDefined();
    const [policy] = await tenant.client.query("zerotrust.policy.get");
    expect(
      policy.rules.some(
        (rule) =>
          rule.origin === "absence-default" &&
          rule.scope === "absence:2" &&
          rule.subject === "user:1",
      ),
    ).toBe(false);
    expect(await tenant.store.query("users.supervisors.getDefault")).toEqual({
      userId: "1",
    });
  } finally {
    personnel.close();
    tenant.store.close();
  }
}, 30000);

test("a backup's supervisor setting is encrypted, repeatable and never replaces a changed destination", async () => {
  const tenant = await protectedTenant(ORGANIZATION_AREAS, () => [...ACTIONS], {
    backup: true,
  });
  tenant.state.roles = [":admin"];
  const source = await createBusinessDatabase(await duckDriver());
  const signal = new AbortController().signal;
  const id = "9223372036854775807";
  const profile = { companyName: "Archivbetrieb", address: null };
  const store = createProtectedSupervisorSettings(
    tenant.client,
    signal,
    duckDriver,
  );
  try {
    await projectCompleteRows(source, [
      row("users", {
        id,
        username: "archive.manager",
        first_name: "Archivierter Vorgesetzter",
        contract_type: "internal",
        ui_locale: "de",
      }),
      row("global_settings", {
        key: "users.defaultSupervisorUserId",
        name: JSON.stringify(id),
      }),
    ]);
    await prepareOrganization(tenant.client, source, "user:1", signal, profile);
    expect(await store.query("users.supervisors.getDefault")).toEqual({
      userId: BigInt(id).toString(32),
    });
    const commits = tenant.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(JSON.stringify(commits)).not.toContain(
      "sortsys-supervisor-settings-v1",
    );
    const before = commits.length;
    await prepareOrganization(tenant.client, source, "user:1", signal, profile);
    expect(
      tenant.calls.filter((call) => call.path === "zerotrust.objects.batch")
        .length,
    ).toBe(before);
    await tenant.seed(supervisorSettingsRequest.area, SUPERVISOR_SETTINGS_ID, {
      format: "sortsys-supervisor-settings-v1",
      userId: "1",
    });
    await expect(
      prepareOrganization(tenant.client, source, "user:1", signal, profile),
    ).rejects.toThrow();
    expect(
      (
        await tenant.plain(
          supervisorSettingsRequest.area,
          SUPERVISOR_SETTINGS_ID,
        )
      ).userId,
    ).toBe("1");
  } finally {
    store.close();
    await source.close();
  }
}, 30000);

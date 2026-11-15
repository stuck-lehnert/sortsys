import { afterEach, expect, test } from "bun:test";
import { ACTIONS, compilePolicy } from "@sortsys/zerotrust/sortsys";
import {
  absenceDefaultRules,
  synchronizeAbsenceDefaults,
  withAbsenceDefaults,
} from "./absenceDefaults";
import { patchAccessRules } from "./accessProfiles";
import { lockCryptoSession } from "./session";
import { absenceCollection } from "../data/absenceData";
import { createProtectedPersonnel } from "../data/personnel";
import { personnelCollection, personnelPart } from "../data/personnelData";
import { row } from "../data/rowCodec.test.mjs";
import { duckDriver } from "../data/testing/duckDriver.mjs";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
afterEach(() => lockCryptoSession());
const people = [
  { id: "1", contractType: "internal", supervisorUserId: null },
  { id: "2", contractType: "internal", supervisorUserId: "1" },
  { id: "3", contractType: "internal", supervisorUserId: "2" },
  { id: "4", contractType: "external", supervisorUserId: "2" },
  { id: "5", contractType: "subcontractor", supervisorUserId: "2" },
];
const base = { tenant: "test", version: "1", rules: [], suspended: [] };
test("certified staff receive own requests, appropriate automatic approval and all supervisor levels", () => {
  const rules = absenceDefaultRules(
      people,
      new Set(people.map((person) => person.id)),
    ),
    policy = { ...base, rules };
  const employee = compilePolicy(policy, ["user:3"]),
    supervisor = compilePolicy(policy, ["user:2"]),
    senior = compilePolicy(policy, ["user:1"]);
  expect(employee.allows("absence:3", "master-data", "create")).toBe(true);
  expect(employee.allows("absence:3", "personnel", "approve")).toBe(false);
  expect(employee.allows("absence:3", "master-data", "delete")).toBe(true);
  expect(employee.allows("absence:3", "personnel", "delete")).toBe(false);
  expect(employee.allows("personnel:3", "scope", "read")).toBe(true);
  expect(employee.allows("personnel:3", "calculation", "read")).toBe(false);
  expect(supervisor.allows("absence:3", "personnel", "approve")).toBe(true);
  expect(senior.allows("absence:3", "personnel", "approve")).toBe(true);
  expect(employee.allows("absence:2", "personnel", "read")).toBe(false);
  for (const id of ["1", "4", "5"])
    expect(
      compilePolicy(policy, [`user:${id}`]).allows(
        `absence:${id}`,
        "personnel",
        "approve",
      ),
    ).toBe(true);
  expect(
    absenceDefaultRules(people, new Set(["1"])).every(
      (rule) => rule.subject === "user:1",
    ),
  ).toBe(true);
});
test("moving an entire supervisor branch removes old defaults and preserves explicit exceptions and denials", () => {
  const explicit = [
    {
      subject: "user:2",
      scope: "absence:4",
      facet: "personnel",
      effect: "allow",
      actions: ["read", "approve"],
    },
    {
      subject: "user:3",
      scope: "absence:3",
      facet: "master-data",
      effect: "deny",
      actions: ["create"],
    },
  ];
  const certified = new Set(people.map((person) => person.id)),
    first = withAbsenceDefaults(
      { ...base, rules: explicit },
      people,
      certified,
    );
  const moved = people.map((person) =>
    person.id === "3" || person.id === "4"
      ? { ...person, supervisorUserId: "1" }
      : person,
  );
  const next = withAbsenceDefaults(first, moved, certified),
    old = compilePolicy(next, ["user:2"]);
  expect(old.allows("absence:3", "personnel", "approve")).toBe(false);
  expect(old.allows("absence:4", "personnel", "approve")).toBe(true);
  expect(next.rules.slice(0, 2)).toEqual(explicit);
  expect(
    compilePolicy(next, ["user:3"]).allows(
      "absence:3",
      "master-data",
      "create",
    ),
  ).toBe(false);
  const patched = patchAccessRules(first.rules, "user:2", [
    { area: absenceCollection("3", true), patch: { approve: false } },
  ]);
  expect(patched.filter((rule) => rule.origin)).toEqual(
    first.rules.filter((rule) => rule.origin),
  );
  const refreshed = withAbsenceDefaults(
    { ...first, rules: patched },
    people,
    certified,
  );
  expect(
    compilePolicy(refreshed, ["user:2"]).allows(
      "absence:3",
      "personnel",
      "approve",
    ),
  ).toBe(false);
});
test("cyclic, incomplete and duplicate personnel graphs never produce replacement permissions", () => {
  for (const source of [
    [...people, people[0]],
    people.map((person) =>
      person.id === "1" ? { ...person, supervisorUserId: "3" } : person,
    ),
    people.filter((person) => person.id !== "2"),
  ])
    expect(() => absenceDefaultRules(source, new Set(["1"]))).toThrow();
});
async function fixture() {
  const profiles = people.slice(0, 3),
    areas = profiles.flatMap((person) => [
      personnelCollection(person.id, "master-data"),
      personnelCollection(person.id, "scope"),
      absenceCollection(person.id),
      absenceCollection(person.id, true),
    ]);
  const f = await protectedTenant(areas, () => [...ACTIONS]);
  f.state.roles = [":admin"];
  for (const person of profiles) {
    const value = row("users", {
      id: person.id,
      username: person.id === "1" ? "owner" : "person" + person.id,
      first_name: "Person " + person.id,
      ui_locale: "de",
      contract_type: person.contractType,
      supervisor_user_id: person.supervisorUserId,
      vacation_days_per_year: "30",
    });
    for (const facet of ["master-data", "scope"]) {
      const area = personnelCollection(person.id, facet);
      await f.seed(area, area.prefix, personnelPart(value, facet));
    }
  }
  return {
    ...f,
    store: createProtectedPersonnel(
      f.client,
      new AbortController().signal,
      duckDriver,
    ),
  };
}
test("profile and derived permissions publish atomically with all hierarchy guards, including a lost reply", async () => {
  const f = await fixture();
  try {
    await synchronizeAbsenceDefaults(
      f.client,
      new AbortController().signal,
      duckDriver,
    );
    const before = (await f.client.query("zerotrust.policy.get"))[0];
    f.state.loseReply = true;
    await f.store.mutate("users.update", {
      id: "2",
      data: { supervisorUserId: null, contractType: "external" },
    });
    const saved = f.calls
      .filter((call) => call.path === "zerotrust.objects.batch")
      .at(-1).input;
    expect(saved.objects).toHaveLength(2);
    expect(saved.heads).toHaveLength(6);
    expect(saved.policy.transaction.previousSignature).toBe(before.signature);
    expect(saved.policy.transaction.packets).toEqual(
      saved.objects.map((packet) => packet.envelope.signature).sort(),
    );
    const after = (await f.client.query("zerotrust.policy.get"))[0];
    expect(after.signature).toBe(saved.policy.signature);
    expect(
      after.rules.some(
        (rule) =>
          rule.origin &&
          rule.subject === "user:1" &&
          rule.scope === "absence:3",
      ),
    ).toBe(false);
    expect(
      (await f.store.query("users.get", { id: "2" })).supervisorUserId,
    ).toBeNull();
  } finally {
    f.store.close();
  }
}, 30000);
test("a changed hierarchy prerequisite or a false reply cannot apply half of a supervisor change", async () => {
  const f = await fixture();
  try {
    await synchronizeAbsenceDefaults(
      f.client,
      new AbortController().signal,
      duckDriver,
    );
    const before = (await f.client.query("zerotrust.policy.get"))[0];
    let conflict = true;
    f.state.beforeCommit = async () => {
      if (conflict) {
        conflict = false;
        f.domains.get(personnelCollection("3", "scope").domain).head++;
      }
    };
    await expect(
      f.store.mutate("users.update", {
        id: "2",
        data: { supervisorUserId: null },
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("users.get", { id: "2" })).supervisorUserId,
    ).toBe("1");
    expect((await f.client.query("zerotrust.policy.get"))[0].signature).toBe(
      before.signature,
    );
    f.state.discardCommit = true;
    await expect(
      f.store.mutate("users.update", {
        id: "2",
        data: { supervisorUserId: null },
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("users.get", { id: "2" })).supervisorUserId,
    ).toBe("1");
    expect((await f.client.query("zerotrust.policy.get"))[0].signature).toBe(
      before.signature,
    );
  } finally {
    f.store.close();
  }
}, 30000);
test("ordinary personnel edits preserve unchanged supervision without requiring tenant authority", async () => {
  const f = await fixture();
  f.state.roles = [];
  try {
    await f.store.mutate("users.update", {
      id: "2",
      data: { phone: "12345", contractType: "internal" },
    });
    expect((await f.store.query("users.get", { id: "2" })).phone).toBe("12345");
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").at(-1)
        .input.policy,
    ).toBeUndefined();
    await expect(
      f.store.mutate("users.update", {
        id: "2",
        data: { contractType: "external" },
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, 30000);

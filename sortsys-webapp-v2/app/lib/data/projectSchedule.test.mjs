import { timestampInstant } from "./timestamps";
import { afterEach, expect, test } from "bun:test";
import { ACTIONS, TOMBSTONE_FORMAT } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import { createBusinessDatabase } from "./database";
import { prepareProjectSchedule } from "./migrateProjectSchedule";
import { personnelCollection, personnelPart } from "./personnelData";
import { projectCollection } from "./projectData";
import { projectCompleteRows } from "./projection";
import { createProtectedProjectSchedule } from "./projectSchedule";
import {
  scheduleCollection,
  scheduleObject,
  schedulePayload,
} from "./projectScheduleData";
import { row } from "./rowCodec.test.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
afterEach(() => lockCryptoSession());
const range = { from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
const deployment = () => ({
  format: "sortsys-project-schedule-v1",
  row: row("project_deployments", {
    id: "3",
    project_id: "2",
    user_id: "6",
    from: "2026-03-29T08:00:00.123456+02:00",
    to: "2026-03-29T16:00:00+02:00",
    note: "Vertrauliche Gerüstplanung",
  }),
});
async function fixture(
  actions = ["read", "create", "update", "delete"],
  seeded = true,
  backup = false,
) {
  const a = scheduleCollection("2"),
    b = scheduleCollection("8"),
    hidden = scheduleCollection("9"),
    person = personnelCollection("6", "master-data"),
    projects = [projectCollection("2"), projectCollection("8")];
  const f = await protectedTenant(
    [a, b, hidden, person, ...projects],
    (area) =>
      area.domain === hidden.domain
        ? []
        : area.domain === a.domain || area.domain === b.domain
          ? actions
          : ["read", "create", "update", "delete"],
    { backup },
  );
  const value = deployment();
  if (seeded) await f.seed(a, scheduleObject("2", "deployment", "3"), value);
  await f.seed(hidden, scheduleObject("9", "deployment", "7"), {
    ...value,
    row: {
      ...value.row,
      values: {
        ...value.row.values,
        id: "7",
        project_id: "9",
        note: "Nicht freigegebene Planung",
      },
    },
  });
  for (const project of projects) {
    const id = project === projects[0] ? "2" : "8";
    await f.seed(project, project.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id, title: "Baustelle " + id }),
      contacts: [],
    });
  }
  await f.seed(
    person,
    person.prefix,
    personnelPart(
      row("users", {
        id: "6",
        username: "mia",
        first_name: "Mia",
        contract_type: "internal",
        ui_locale: "de",
      }),
      "master-data",
    ),
  );
  return {
    ...f,
    a,
    b,
    hidden,
    value,
    store: createProtectedProjectSchedule(
      f.client,
      new AbortController().signal,
      duckDriver,
    ),
  };
}
test("schedule payloads bind table, project, row identity, storage placement and exact time ranges", () => {
  const value = deployment(),
    object = scheduleObject("2", "deployment", "3");
  expect(schedulePayload(value, object, "2").row.values.from).toBe(
    value.row.values.from,
  );
  for (const wrong of [
    scheduleObject("8", "deployment", "3"),
    scheduleObject("2", "unavailability", "3"),
    scheduleObject("2", "deployment", "4"),
    object + ":extra",
  ])
    expect(() => schedulePayload(value, wrong, "2")).toThrow();
  expect(() =>
    schedulePayload(
      {
        ...value,
        row: {
          ...value.row,
          values: { ...value.row.values, to: value.row.values.from },
        },
      },
      object,
      "2",
    ),
  ).toThrow();
  for (const bad of ["2026-02-30T12:00:00Z", "2026-03-29", 12, new Date(NaN)])
    expect(() => timestampInstant(bad)).toThrow();
});
test("planning filters use half-open instant ranges, inclusive calendar days and no unreadable project keys", async () => {
  const f = await fixture();
  try {
    expect(
      (await f.store.query("projects.deployments.list", range)).map(
        (value) => value.id,
      ),
    ).toEqual(["3"]);
    expect(
      await f.store.query("projects.deployments.list", {
        from: "2026-03-29T16:00:00+02:00",
        to: range.to,
      }),
    ).toEqual([]);
    expect(
      await f.store.query("projects.deployments.list", {
        ...range,
        userId: "7",
      }),
    ).toEqual([]);
    await f.store.mutate("projects.unavailability.create", {
      operationId: "4",
      projectId: "2",
      from: "2026-03-29",
      to: "2026-03-29",
      reason: "Gerüstabbau",
      note: "Zugang gesperrt",
    });
    expect(
      (
        await f.store.query("projects.unavailability.list", {
          from: "2026-03-29",
          to: "2026-03-29",
        })
      ).map((value) => value.reason),
    ).toEqual(["Gerüstabbau"]);
    expect(
      await f.store.query("projects.unavailability.list", {
        from: "2026-03-30",
      }),
    ).toEqual([]);
    expect(
      f.calls
        .filter((call) => isKeyEnvelopeQuery(call.path))
        .some((call) => call.input.domain === f.hidden.domain),
    ).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain("Zugang gesperrt");
    expect(JSON.stringify(f.calls)).not.toContain("Vertrauliche Gerüstplanung");
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20_000));
test("new assignments survive lost replies and retry with the same operation ID without duplicate bookings", async () => {
  const f = await fixture();
  try {
    const input = {
      operationId: "5",
      projectId: "2",
      userId: "6",
      from: range.from,
      to: "2026-03-01T09:00:00Z",
      note: "Materialfahrt",
    };
    f.state.loseReply = true;
    expect(await f.store.mutate("projects.deployments.create", input)).toEqual({
      id: "5",
    });
    const count = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    expect(await f.store.mutate("projects.deployments.create", input)).toEqual({
      id: "5",
    });
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(count);
    await expect(
      f.store.mutate("projects.deployments.create", {
        ...input,
        note: "Anderer Inhalt",
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, 20000);
test("moving to another project and back is atomic, preserves the public ID and cannot admit an old placement version", async () => {
  const f = await fixture();
  try {
    const [first] = await f.store.query("projects.deployments.list", range);
    f.state.loseReply = true;
    await f.store.mutate("projects.deployments.update", {
      id: "3",
      expectedRevision: first.revision,
      data: { projectId: "8" },
    });
    const [moved] = await f.store.query("projects.deployments.list", range);
    expect(moved.projectId).toBe("8");
    expect(moved.id).toBe("3");
    expect(f.objects.get(scheduleObject("2", "deployment", "3")).format).toBe(
      TOMBSTONE_FORMAT,
    );
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").at(-1)
        .input.objects,
    ).toHaveLength(2);
    await f.store.mutate("projects.deployments.update", {
      id: "3",
      expectedRevision: moved.revision,
      data: { projectId: "2" },
    });
    const [back] = await f.store.query("projects.deployments.list", range);
    expect(back.projectId).toBe("2");
    expect(back.revision).not.toBe(first.revision);
    await expect(
      f.store.mutate("projects.deployments.update", {
        id: "3",
        expectedRevision: first.revision,
        data: { note: "Veraltetes Formular" },
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("projects.deployments.list", range))[0].note,
    ).toBe(first.note);
  } finally {
    f.store.close();
  }
}, 20000);
test("a simultaneous edit prevents both halves of a move from being committed", async () => {
  const f = await fixture();
  try {
    f.state.beforeCommit = async () => {
      f.state.beforeCommit = async () => {};
      await f.seed(f.a, scheduleObject("2", "deployment", "3"), {
        ...f.value,
        row: {
          ...f.value.row,
          values: {
            ...f.value.row.values,
            note: "Von anderer Instanz geändert",
          },
        },
      });
    };
    await expect(
      f.store.mutate("projects.deployments.update", {
        id: "3",
        data: { projectId: "8" },
      }),
    ).rejects.toThrow();
    expect(
      [...f.objects.values()].some((value) => value.scope === f.b.scope),
    ).toBe(false);
    expect(
      (await f.store.query("projects.deployments.list", range))[0],
    ).toMatchObject({ projectId: "2", note: "Von anderer Instanz geändert" });
  } finally {
    f.store.close();
  }
}, 20000);
test("read/delete permits removing a booking while denying ordinary edits and project moves", async () => {
  const f = await fixture(["read", "delete"]);
  try {
    await expect(
      f.store.mutate("projects.deployments.update", {
        id: "3",
        data: { note: "Nicht erlaubt" },
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("projects.deployments.update", {
        id: "3",
        data: { projectId: "8" },
      }),
    ).rejects.toThrow();
    const [current] = await f.store.query("projects.deployments.list", range);
    await f.store.mutate("projects.deployments.delete", {
      id: "3",
      expectedRevision: current.revision,
    });
    expect(await f.store.query("projects.deployments.list", range)).toEqual([]);
  } finally {
    f.store.close();
  }
}, 20000);
test("source conversion preserves times and notes, creates empty project areas and refuses conflicting targets", async () => {
  const f = await fixture([...ACTIONS], false, true),
    source = await createBusinessDatabase(await duckDriver());
  try {
    const person = row("users", {
      id: "6",
      username: "mia",
      contract_type: "internal",
      ui_locale: "de",
    });
    const period = row("project_unavailability_periods", {
      id: "4",
      project_id: "2",
      created_by_user_id: "6",
      from: "2026-03-29",
      to: "2026-03-30",
      reason: "Baustrom fehlt",
    });
    await projectCompleteRows(source, [
      person,
      row("projects", { id: "2" }),
      row("projects", { id: "8" }),
      f.value.row,
      period,
    ]);
    await prepareProjectSchedule(
      f.client,
      source,
      "user:1",
      new AbortController().signal,
    );
    const saved = await f.plain(
      f.a,
      scheduleObject("2", "unavailability", "4"),
    );
    expect(saved.row.values.reason).toBe("Baustrom fehlt");
    const count = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    await prepareProjectSchedule(
      f.client,
      source,
      "user:1",
      new AbortController().signal,
    );
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(count);
    await f.seed(f.a, scheduleObject("2", "deployment", "3"), {
      ...f.value,
      row: {
        ...f.value.row,
        values: { ...f.value.row.values, note: "Bewusst abweichend" },
      },
    });
    await expect(
      prepareProjectSchedule(
        f.client,
        source,
        "user:1",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  } finally {
    f.store.close();
    await source.close();
  }
}, 20000);
test("ordinary planning subscriptions remove deleted and moved-away rows and stop revealing values after lock", async () => {
  const f = await fixture(),
    business = createBusinessClient(f.client, { productDriver: duckDriver }),
    values = [];
  const subscription = business
    .streamQuery("projects.deployments.list", { ...range, projectId: "2" })
    .subscribe(([rows, error]) => {
      values.push({ rows, error });
    });
  async function until(predicate) {
    const end = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > end)
        throw new Error("Planning subscription did not refresh");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    await until(() => values.some((value) => value.rows?.length === 1));
    const [, error] = await business.mutate("projects.deployments.update", {
      id: "3",
      data: { projectId: "8" },
    });
    expect(error).toBeNull();
    await until(() => values.at(-1).rows?.length === 0);
    lockCryptoSession();
    await until(() => values.at(-1).error);
    expect(values.at(-1).rows).toBeNull();
  } finally {
    subscription.unsubscribe();
    business.dispose();
    f.store.close();
  }
}, 20000);

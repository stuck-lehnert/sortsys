import { afterEach, expect, test } from "bun:test";
import { DEFAULT_GAEB_VIEW } from "@sortsys/gaeb";
import { lockCryptoSession } from "../crypto/session";
import { createProtectedPersonalHistory } from "./personalHistory";
import { createProtectedPreferences } from "./preferences";
import { createBusinessClient } from "./businessClient";
import {
  PERSONAL_HISTORY_MODEL,
  historyCollection,
  historyObject,
  historyPayload,
  historyPath,
  recentHistory,
} from "./personalHistoryData";
import { gaebViewCollection, gaebViewObject } from "./preferenceData";
import { copyPersonalHistory } from "./migratePersonalHistory";
import { importLegacyDashboardPins } from "./legacyDashboardPins";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { row } from "./rowCodec.test.mjs";

afterEach(() => lockCryptoSession());
async function fixture(backup = false) {
  const area = historyCollection("user:1");
  const f = await protectedTenant(
    [area, historyCollection("user:2")],
    undefined,
    { backup },
  );
  const controller = new AbortController();
  const store = createProtectedPersonalHistory(
    f.client,
    controller.signal,
    duckDriver,
  );
  return { ...f, area, store, controller };
}
const pin = (id, title = `Privates Projekt ${id}`) => ({
  path: `/projects/${id}`,
  title,
  visitedAt: new Date("2026-11-12T12:00:00Z"),
});
const visit = (id, user = "1", date = "2026-11-12T12:00:00.000001Z") =>
  row("user_visit_history", {
    id,
    user_id: user,
    path: `/projects/${id}`,
    title: `Vertraulich ${id}`,
    visited_at: date,
  });

test("visits, quick actions and dashboard pins share the encrypted personal area without breaking GAEB preferences", async () => {
  const f = await fixture();
  const preferences = createProtectedPreferences(
    f.client,
    f.controller.signal,
    duckDriver,
  );
  try {
    await f.seed(gaebViewCollection("user:1"), gaebViewObject("user:1"), {
      format: "sortsys-preferences-v1",
      subject: "user:1",
      view: DEFAULT_GAEB_VIEW,
    });
    expect(await f.store.query("personalization.visits.list", {})).toEqual([]);
    await f.store.mutate("personalization.visits.append", {
      path: " /projects/3 ",
      title: " Vertrauliches Angebot ",
    });
    await f.store.mutate("personalization.actions.append", {
      actionId: "offers.create",
      label: "Neues Angebot",
      href: "/offers",
    });
    await f.store.mutate("personalization.dashboard.pins.pin", pin("3"));
    expect(
      (await f.store.query("personalization.visits.list", {}))[0],
    ).toMatchObject({ path: "/projects/3", title: "Vertrauliches Angebot" });
    expect(
      (await f.store.query("personalization.actions.list", {}))[0],
    ).toMatchObject({
      actionId: "offers.create",
      label: "Neues Angebot",
      href: "/offers",
    });
    expect(
      await f.store.query("personalization.dashboard.pins.get", {}),
    ).toEqual([pin("3")]);
    expect(await preferences.get()).toEqual(DEFAULT_GAEB_VIEW);
    await preferences.set({ ...DEFAULT_GAEB_VIEW, outlineWidth: 400 });
    expect(await f.store.query("personalization.visits.list", {})).toHaveLength(
      1,
    );
    const wire = JSON.stringify(f.calls);
    for (const secret of [
      "Vertrauliches Angebot",
      "Privates Projekt 3",
      '"path":"/projects/3"',
      '"label":"Neues Angebot"',
    ])
      expect(wire).not.toContain(secret);
    expect(
      f.calls.some((call) => call.path.startsWith("personalization.")),
    ).toBe(false);
  } finally {
    preferences.close();
    f.store.close();
  }
}, fixtureTimeout(30_000));

test("models reject foreign owners, wrong history types, duplicate IDs, unsupported fields and unsafe navigation", () => {
  const area = historyCollection("user:1");
  const value = {
    format: "sortsys-personal-history-v1",
    subject: "user:1",
    kind: "visits",
    rows: [visit("3")],
  };
  expect(
    historyPayload(value, historyObject("user:1", "visits"), "user:1").rows,
  ).toHaveLength(1);
  for (const change of [
    { subject: "user:2" },
    { kind: "actions" },
    { rows: [visit("3", "2")] },
    { rows: [visit("3"), visit("3")] },
    { arbitrary: null },
  ])
    expect(() =>
      PERSONAL_HISTORY_MODEL.decode(
        { ...value, ...change },
        historyObject("user:1", "visits"),
        area,
      ),
    ).toThrow();
  for (const path of [
    "javascript:alert(1)",
    "https://evil.test/",
    "//evil.test",
    "/\\evil.test",
    "/\n/evil.test",
    "",
    " relative ",
  ])
    expect(() => historyPath(path)).toThrow();
});

test("retention is atomic, matches the 100/200 limits and sorts source microseconds before numeric IDs", async () => {
  const f = await fixture();
  try {
    const values = Array.from({ length: 102 }, (_, i) =>
      visit(String(i + 1), "1", "2026-11-12T12:00:00.000001Z"),
    );
    values[0] = visit("1", "1", "2026-11-12T12:00:00.000002Z");
    const sorted = recentHistory(values, "visits");
    expect(sorted).toHaveLength(100);
    expect(sorted[0].values.id).toBe("1");
    expect(sorted[1].values.id).toBe("102");
    await f.seed(f.area, historyObject("user:1", "visits"), {
      format: "sortsys-personal-history-v1",
      subject: "user:1",
      kind: "visits",
      rows: sorted,
    });
    await f.store.mutate("personalization.visits.append", { path: "/tools/4" });
    expect(
      await f.store.query("personalization.visits.list", { limit: 10000 }),
    ).toHaveLength(100);
    expect(
      await f.store.query("personalization.visits.list", { limit: -1 }),
    ).toHaveLength(1);
    await expect(
      f.store.query("personalization.visits.list", { limit: "10" }),
    ).rejects.toThrow();
    const actions = Array.from({ length: 200 }, (_, i) =>
      row("user_action_history", {
        id: String(i + 1),
        user_id: "1",
        action_id: "offers.create",
        label: "Angebot",
        href: null,
        used_at: "2026-01-01T00:00:00Z",
      }),
    );
    await f.seed(f.area, historyObject("user:1", "actions"), {
      format: "sortsys-personal-history-v1",
      subject: "user:1",
      kind: "actions",
      rows: actions,
    });
    await f.store.mutate("personalization.actions.append", {
      actionId: "tools.track",
      label: "Werkzeuge",
    });
    expect(
      await f.store.query("personalization.actions.list", { limit: 1000 }),
    ).toHaveLength(200);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(30_000));

test("a second independent runtime retries a genuine head conflict without losing either append", async () => {
  const f = await fixture();
  const peer = { ...f.client };
  const other = createProtectedPersonalHistory(
    peer,
    new AbortController().signal,
    duckDriver,
  );
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  let commits = 0;
  f.state.beforeCommit = async () => {
    if (++commits === 2) release();
    if (commits <= 2) await barrier;
  };
  try {
    await Promise.all([
      f.store.mutate("personalization.visits.append", { path: "/projects/3" }),
      other.mutate("personalization.visits.append", { path: "/projects/4" }),
    ]);
    await f.store.refresh();
    expect(
      (await f.store.query("personalization.visits.list", {}))
        .map((row) => row.path)
        .sort(),
    ).toEqual(["/projects/3", "/projects/4"]);
    expect(commits).toBeGreaterThanOrEqual(3);
  } finally {
    release();
    f.store.close();
    other.close();
  }
}, fixtureTimeout(30_000));

test("lost acknowledgements use readback, false acknowledgements never appear as saved visits", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;
    await f.store.mutate("personalization.visits.append", {
      path: "/projects/3",
    });
    expect(await f.store.query("personalization.visits.list", {})).toHaveLength(
      1,
    );
    f.state.loseReply = false;
    f.state.discardCommit = true;
    await expect(
      f.store.mutate("personalization.visits.append", { path: "/projects/4" }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("personalization.visits.list", {})).map(
        (value) => value.path,
      ),
    ).toEqual(["/projects/3"]);
  } finally {
    f.state.discardCommit = false;
    f.store.close();
  }
}, fixtureTimeout(30_000));

test("pin insertion, drag ordering, keyboard ordering, removal and one-time local import preserve current server edits", async () => {
  const f = await fixture();
  try {
    for (const id of ["3", "4", "5"])
      await f.store.mutate("personalization.dashboard.pins.pin", pin(id));
    const paths = async () =>
      (await f.store.query("personalization.dashboard.pins.get", {})).map(
        (value) => value.path,
      );
    expect(await paths()).toEqual([
      "/projects/5",
      "/projects/4",
      "/projects/3",
    ]);
    await f.store.mutate("personalization.dashboard.pins.move", {
      path: "/projects/3",
      target: "/projects/5",
    });
    expect(await paths()).toEqual([
      "/projects/3",
      "/projects/5",
      "/projects/4",
    ]);
    await f.store.mutate("personalization.dashboard.pins.move", {
      path: "/projects/3",
      offset: 1,
    });
    expect(await paths()).toEqual([
      "/projects/5",
      "/projects/3",
      "/projects/4",
    ]);
    await f.store.mutate("personalization.dashboard.pins.unpin", {
      path: "/projects/5",
    });
    await f.store.mutate("personalization.dashboard.pins.import", {
      entries: [pin("6")],
    });
    await f.store.mutate("personalization.dashboard.pins.unpin", {
      path: "/projects/6",
    });
    await f.store.mutate("personalization.dashboard.pins.import", {
      entries: [pin("6")],
    });
    expect(await paths()).toEqual(["/projects/3", "/projects/4"]);
    for (const input of [
      { path: "/projects/3", target: "/projects/4", offset: 1 },
      { path: "/projects/3", offset: 0 },
      { path: "/projects/3", target: "//evil.test" },
    ])
      await expect(
        f.store.mutate("personalization.dashboard.pins.move", input),
      ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(30_000));

test("migration preserves each person's records, repeats safely and does not overwrite a changed source or destination", async () => {
  const f = await fixture(true);
  const values = new Map([
    ["user:1", { visits: [visit("3")], actions: [] }],
    ["user:2", { visits: [visit("4", "2")], actions: [] }],
  ]);
  try {
    const existingPin = pin("9");
    await f.store.mutate("personalization.dashboard.pins.pin", existingPin);
    const start = f.calls.length;

    await copyPersonalHistory(f.client, values, f.controller.signal);
    const copies = () =>
      f.calls
        .slice(start)
        .filter((call) => call.path === "zerotrust.objects.batch");
    expect(copies()).toHaveLength(1);
    const [{ input }] = copies();
    expect(input.heads.map(({ domain }) => domain)).toEqual(
      ["user:1", "user:2"].map((subject) => historyCollection(subject).domain),
    );
    expect(input.objects.map(({ envelope }) => envelope.object)).toEqual(
      ["user:1", "user:2"].flatMap((subject) => [
        historyObject(subject, "visits"),
        historyObject(subject, "actions"),
      ]),
    );
    await copyPersonalHistory(f.client, values, f.controller.signal);
    expect(copies()).toHaveLength(1);

    expect(
      await f.store.query("personalization.dashboard.pins.get", {}),
    ).toEqual([existingPin]);
    expect(
      (await f.store.query("personalization.visits.list", {})).map(
        (row) => row.path,
      ),
    ).toEqual(["/projects/3"]);
    await expect(
      f.store.query("personalization.visits.list", { userId: "2" }),
    ).rejects.toThrow();
    const changed = new Map([
      ["user:1", { visits: [visit("5")], actions: [] }],
    ]);
    await expect(
      copyPersonalHistory(f.client, changed, f.controller.signal),
    ).rejects.toThrow();
    expect(copies()).toHaveLength(1);

    await f.store.mutate("personalization.visits.append", { path: "/tools/5" });
    const beforeConflict = copies().length;
    await expect(
      copyPersonalHistory(f.client, values, f.controller.signal),
    ).rejects.toThrow();
    expect(copies()).toHaveLength(beforeConflict);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(90_000));

test("account lock and cancellation discard pending work and old snapshots", async () => {
  const f = await fixture();
  try {
    await f.store.mutate("personalization.visits.append", {
      path: "/projects/3",
    });
    await lockCryptoSession();
    await expect(
      f.store.query("personalization.visits.list", {}),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("personalization.visits.append", { path: "/projects/4" }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(5_000));

test("the business facade exposes histories and pin updates without falling through to plaintext RPCs", async () => {
  const f = await fixture();
  const app = createBusinessClient(f.client, { productDriver: duckDriver });
  try {
    expect(
      (
        await app.mutate("personalization.visits.append", {
          path: "/projects/3",
          title: "Privat",
        })
      )[1],
    ).toBeNull();
    expect(
      (await app.query("personalization.visits.list", {}))[0][0].path,
    ).toBe("/projects/3");
    let changed = 0;
    const stop = app.dashboard.listen(() => changed++);
    await app.dashboard.pin(pin("3"));
    expect(await app.dashboard.get()).toEqual([pin("3")]);
    expect(changed).toBeGreaterThan(0);
    stop();
    expect(
      f.calls.some((call) => call.path.startsWith("personalization.")),
    ).toBe(false);
  } finally {
    app.dispose();
    f.store.close();
  }
}, fixtureTimeout(5_000));

test("legacy local pins are deleted only after verified migration for the exact tenant and user", async () => {
  const key = "webapp::dashboard.pinnedVisits:test:1";
  const other = "webapp::dashboard.pinnedVisits:other:1";
  const data = new Map([
    [key, JSON.stringify([pin("3")])],
    [other, JSON.stringify([pin("4")])],
  ]);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
  };
  await expect(
    importLegacyDashboardPins(
      storage,
      "test",
      "1",
      async () => {
        throw new Error("not saved");
      },
      () => {},
    ),
  ).rejects.toThrow();
  expect(data.has(key)).toBe(true);
  let saved;
  await importLegacyDashboardPins(
    storage,
    "test",
    "1",
    async (entries) => (saved = entries),
    () => {},
  );
  expect(saved).toEqual([pin("3")]);
  expect(data.has(key)).toBe(false);
  expect(data.has(other)).toBe(true);
  data.set(key, JSON.stringify([pin("3")]));
  let active = true;
  await expect(
    importLegacyDashboardPins(
      storage,
      "test",
      "1",
      async () => {
        active = false;
      },
      () => {
        if (!active) throw new Error("account changed");
      },
    ),
  ).rejects.toThrow();
  expect(data.has(key)).toBe(true);
}, fixtureTimeout(5_000));

test("a false success during legacy import retains its plaintext source until encrypted readback succeeds", async () => {
  const f = await fixture();
  const app = createBusinessClient(f.client, { productDriver: duckDriver });
  const key = "webapp::dashboard.pinnedVisits:test:1";
  const data = new Map([[key, JSON.stringify([pin("3")])]]);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    removeItem: (key) => data.delete(key),
  };
  try {
    f.state.discardCommit = true;
    await expect(
      importLegacyDashboardPins(
        storage,
        "test",
        "1",
        app.dashboard.importLocal,
        () => {},
      ),
    ).rejects.toThrow();
    expect(data.has(key)).toBe(true);
    expect(await app.dashboard.get()).toEqual([]);
    f.state.discardCommit = false;
    await importLegacyDashboardPins(
      storage,
      "test",
      "1",
      app.dashboard.importLocal,
      () => {},
    );
    expect(data.has(key)).toBe(false);
    expect(await app.dashboard.get()).toEqual([pin("3")]);
  } finally {
    f.state.discardCommit = false;
    app.dispose();
    f.store.close();
  }
}, fixtureTimeout(5_000));

import { expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { CONTACT_COLLECTION } from "./addressBook";
import { ProtectedWriteConflict } from "./atomicWrites";
import { projectCollection } from "./projectData";
import { createProtectedProjects } from "./projects";
import { setReadableAreasConnection } from "./readableAreas";
import { announceDataChanges } from "./runtime/changes";
import { acquireDataRuntime } from "./runtime/session";
import { row } from "./testing/businessRow.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

test("project contacts load by signed link and do not return stale selections", async () => {
  const area = projectCollection("2");
  const { client, calls, seed } = await protectedTenant(
    [area, CONTACT_COLLECTION],
    () => ["read"],
  );
  const projects = createProtectedProjects(
    client,
    new AbortController().signal,
    async () => {
      throw new Error("Directory not needed");
    },
    duckDriver,
  );

  try {
    for (const [id, name] of [["3", "Zeller"], ["4", "Auer"], ["5", "Beck"]]) {
      await seed(CONTACT_COLLECTION, CONTACT_COLLECTION.prefix + id, {
        format: "sortsys-address-v1",
        kind: "contacts",
        row: row("contacts", {
          id,
          last_name: name,
          phone_numbers: "[]",
          email_addresses: "[]",
        }),
        links: [],
      });
    }
    const original = {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Sanierung" }),
      contacts: [
        row("project_contacts", {
          project_id: "2",
          contact_id: "3",
          label: "Bauleitung",
        }),
        row("project_contacts", {
          project_id: "2",
          contact_id: "4",
          label: null,
        }),
        row("project_contacts", {
          project_id: "2",
          contact_id: "6",
          label: "Altbestand",
        }),
      ],
    };
    await seed(area, area.prefix, original);

    const list = () => projects.query("projects.contacts.list", { projectId: "2" });
    const contacts = await list();
    expect(contacts.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "4", label: null },
      { id: "3", label: "Bauleitung" },
    ]);

    const reads = calls.flatMap(({ path, input }) => {
      if (path === "zerotrust.objects.list") return [input];
      if (path === "zerotrust.objects.pages") return input.selections;
      if (path.startsWith("zerotrust.access.")) {
        return input.pages?.selections ?? [];
      }
      return [];
    });
    const contactPages = reads.filter(({ domain }) => domain === CONTACT_COLLECTION.domain);
    const contactBatches = calls.filter(
      ({ path, input }) =>
        path === "zerotrust.objects.getMany" && input.domain === CONTACT_COLLECTION.domain,
    );

    expect(contactPages.filter((page) => !page.headOnly)).toEqual([]);
    expect(contactBatches.map(({ input }) => input.ids)).toEqual([
      ["contact:3", "contact:4", "contact:6"],
    ]);

    const query = client.query.bind(client);
    client.query = async (path, input, options) => {
      if (
        path === "zerotrust.objects.getMany" &&
        input.domain === CONTACT_COLLECTION.domain
      ) {
        client.query = query;
        await seed(area, area.prefix, {
          ...original,
          contacts: [
            row("project_contacts", {
              project_id: "2",
              contact_id: "5",
              label: "Neue Bauleitung",
            }),
          ],
        });

        announceDataChanges(client, new Set([area.domain]));
      }
      return query(path, input, options);
    };

    announceDataChanges(client, new Set([CONTACT_COLLECTION.domain]));
    await expect(list()).rejects.toBeInstanceOf(ProtectedWriteConflict);
    expect((await list()).map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "5", label: "Neue Bauleitung" },
    ]);
  } finally {
    projects.close();
    lockCryptoSession();
  }
}, 120_000);

test("project change ordering keeps microseconds before applying the search limit", async () => {
  const entries = [
    { id: "2", title: "Sanierung A", modified_at: "2026-01-02T12:00:00Z" },
    {
      id: "3",
      title: "Sanierung B",
      modified_at: "2026-01-03T12:00:00.123123Z",
    },
    {
      id: "4",
      title: "Sanierung Y",
      modified_at: "2026-01-03T13:00:00.123124+01:00",
    },
    { id: "5", title: "Neubau", modified_at: "2026-01-04T12:00:00Z" },
    {
      id: "6",
      title: "Sanierung Z",
      modified_at: "2026-01-03T12:00:00.123124Z",
    },
  ];
  const areas = entries.map(({ id }) => projectCollection(id));
  const tenant = await protectedTenant(areas, () => ["read"]);
  const projects = createProtectedProjects(
    tenant.client,
    new AbortController().signal,
    async () => {
      throw new Error("Directory not needed");
    },
    duckDriver,
  );

  try {
    for (const [index, entry] of entries.entries()) {
      const area = areas[index];
      await tenant.seed(area, area.prefix, {
        format: "sortsys-project-v1",
        project: row("projects", {
          ...entry,
          created_at: "2026-01-01T12:00:00Z",
        }),
        contacts: [],
      });
    }

    const search = { search: "Sanierung" };
    const visibleIds = async (input) =>
      (await projects.query("projects.list", input, 2)).map(({ id }) => id);

    expect(await visibleIds(search)).toEqual(["2", "3"]);
    expect(await visibleIds({ ...search, orderBy: "activity" })).toEqual([
      "4",
      "6",
    ]);
    expect(await visibleIds(search)).toEqual(["2", "3"]);
  } finally {
    projects.close();
    lockCryptoSession();
  }
}, 60_000);

test("warm project reads, including offer labels, do not wait for another projection", async () => {
  const area = projectCollection("2");
  const { client, calls, seed } = await protectedTenant(
    [area, CONTACT_COLLECTION],
    () => ["read"],
  );
  const signal = new AbortController().signal;
  const lease = acquireDataRuntime(client, signal, duckDriver);
  const projects = createProtectedProjects(client, signal, async () => {
    throw new Error("Directory not needed");
  });

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const list = () => projects.query("projects.list", { orderBy: "activity" });
  const contacts = () =>
    projects.query("projects.contacts.list", { projectId: "2" });
  let holder;
  let visible;
  let timeout;

  try {
    await seed(area, area.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Sanierung" }),
      contacts: [
        row("project_contacts", { project_id: "2", contact_id: "3", label: null }),
      ],
    });
    await seed(CONTACT_COLLECTION, CONTACT_COLLECTION.prefix + "3", {
      format: "sortsys-address-v1",
      kind: "contacts",
      row: row("contacts", {
        id: "3",
        last_name: "Auer",
        phone_numbers: "[]",
        email_addresses: "[]",
      }),
      links: [],
    });

    setReadableAreasConnection(client, true);
    const expected = await list();
    const expectedContacts = await contacts();
    expect(expected.map(({ title }) => title)).toEqual(["Sanierung"]);
    expect(expectedContacts.map(({ id }) => id)).toEqual(["3"]);

    holder = lease.runtime.read([], async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const rpcCount = calls.length;
    const deadline = new Promise((resolve) => {
      timeout = setTimeout(() => resolve("Blocked by unrelated projection"), 2000);
    });

    visible = contacts();
    expect(await Promise.race([visible, deadline])).toEqual(expectedContacts);
    expect(calls.slice(rpcCount).map(({ path }) => path)).toEqual([]);

    visible = projects.getMany(["2"]);
    expect(await Promise.race([visible, deadline])).toEqual(expected);
    expect(calls.slice(rpcCount).map(({ path }) => path)).toEqual([]);

    visible = Promise.all([
      list(),
      projects.query("projects.get", { id: "2" }),
    ]);
    expect(await Promise.race([visible, deadline])).toEqual([
      expected,
      expected[0],
    ]);

    release.resolve();
    await holder;

    await seed(area, area.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Sanierung Nord" }),
      contacts: [],
    });
    announceDataChanges(client, new Set([area.domain]));

    expect((await projects.getMany(["2"])).map(({ title }) => title)).toEqual([
      "Sanierung Nord",
    ]);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await holder;
    await visible?.catch(() => undefined);
    setReadableAreasConnection(client, false);
    projects.close();
    lease.close();
    lockCryptoSession();
  }
}, 60_000);

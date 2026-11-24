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

test("the warm project directory and detail run while another projection holds the runtime queue", async () => {
  const area = projectCollection("2");
  const { client, seed } = await protectedTenant([area], () => ["read"]);
  const signal = new AbortController().signal;
  const lease = acquireDataRuntime(client, signal, duckDriver);
  const projects = createProtectedProjects(client, signal, async () => {
    throw new Error("Directory not needed");
  });

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const list = () => projects.query("projects.list", { orderBy: "activity" });
  let holder;
  let timeout;

  try {
    await seed(area, area.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Sanierung" }),
      contacts: [],
    });

    setReadableAreasConnection(client, true);
    const expected = await list();
    expect(expected.map(({ title }) => title)).toEqual(["Sanierung"]);

    holder = lease.runtime.read([], async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const deadline = new Promise((resolve) => {
      timeout = setTimeout(() => resolve("Blocked by unrelated projection"), 2000);
    });
    const visible = Promise.all([
      list(),
      projects.query("projects.get", { id: "2" }),
    ]);
    expect(await Promise.race([visible, deadline])).toEqual([expected, expected[0]]);
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await holder;
    setReadableAreasConnection(client, false);
    projects.close();
    lease.close();
    lockCryptoSession();
  }
}, 60_000);

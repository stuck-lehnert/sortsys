import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { CONTACT_COLLECTION, CUSTOMER_COLLECTION } from "./addressBook";
import { createBusinessClient } from "./businessClient";
import { copyRemarks } from "./migrateRemarks";
import { projectCollection } from "./projectData";
import {
  remarkAreaFromScope,
  remarkBody,
  remarkCollection,
  remarkDomain,
  remarkObject,
  remarkPayload,
  remarkResource,
  remarkResourceFromRow,
} from "./remarkData";
import { createProtectedRemarks } from "./remarks";
import { row } from "./rowCodec.test.mjs";
import { toolCollection, toolPart } from "./toolData";
import { duckDriver } from "./testing/duckDriver.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

const resources = ["project", "customer", "contact", "tool"].map(
  (resourceType) => ({ resourceType, resourceId: "2" }),
);
const project = resources[0];
const otherProject = { resourceType: "project", resourceId: "3" };
const body = "Interner Vermerk 613945: Material erst nach Freigabe bestellen.";
const columns = {
  project: "project_id",
  customer: "customer_id",
  contact: "contact_id",
  tool: "tool_id",
};

function noteRow(resource = project, id = "7", changes = {}) {
  return row("resource_notes", {
    id,
    [columns[resource.resourceType]]: resource.resourceId,
    body,
    created_by_user_id: "4",
    created_at: "2026-01-02T10:00:00.123456Z",
    modified_at: "2026-01-03T10:00:00.123457Z",
    ...changes,
  });
}

function projectPayload(id, deleted = false) {
  return {
    format: "sortsys-project-v1",
    project: deleted
      ? null
      : row("projects", { id, title: "Fenstersanierung" }),
    contacts: [],
  };
}

async function fixture(actions, backup = false) {
  const projectArea = projectCollection("2");
  const otherProjectArea = projectCollection("3");
  const toolArea = toolCollection("tool", "2", "master-data");
  const f = await protectedTenant(
    [
      projectArea,
      otherProjectArea,
      CUSTOMER_COLLECTION,
      CONTACT_COLLECTION,
      toolArea,
    ],
    actions,
    { backup },
  );
  await f.seed(projectArea, projectArea.prefix, projectPayload("2"));
  await f.seed(otherProjectArea, otherProjectArea.prefix, projectPayload("3"));
  for (const [kind, area] of [
    ["customers", CUSTOMER_COLLECTION],
    ["contacts", CONTACT_COLLECTION],
  ]) {
    const value = row(kind, {
      id: "2",
      phone_numbers: "[]",
      email_addresses: "[]",
    });
    if (kind === "contacts") value.values.first_name = "Mara";
    await f.seed(area, area.prefix + "2", {
      format: "sortsys-address-v1",
      kind,
      row: value,
      links: [],
    });
  }
  await f.seed(
    toolArea,
    toolArea.prefix,
    toolPart("tool", "2", "master-data", [
      row("tools", { id: "2", brand: "Muster", category: "Bohrmaschine" }),
    ]),
  );
  const controller = new AbortController();
  const store = createProtectedRemarks(f.client, controller.signal, duckDriver);
  const seedNote = (source) =>
    f.seed(
      remarkCollection(remarkResourceFromRow(source)),
      remarkObject(source.values.id),
      {
        format: "sortsys-remark-v1",
        row: source,
      },
    );
  return {
    ...f,
    projectArea,
    otherProjectArea,
    toolArea,
    store,
    controller,
    seedNote,
  };
}

test("remark models bind one exact parent, object identity, area and private schema", () => {
  for (const resource of resources) {
    const source = noteRow(resource);
    const area = remarkCollection(resource);
    const payload = { format: "sortsys-remark-v1", row: source };
    expect(remarkPayload(payload, "remark:7", area).row).toEqual(source);
    expect(remarkResourceFromRow(source)).toEqual(resource);
    expect(remarkAreaFromScope(area.scope)).toEqual(area);
    expect(remarkDomain(area.domain)).toBe(true);
    for (const changed of [
      { scope: "organization" },
      { facet: "calculation" },
      { prefix: "customer:" },
      { domain: "organization:master-data" },
    ]) {
      expect(() =>
        remarkPayload(payload, "remark:7", { ...area, ...changed }),
      ).toThrow();
    }
    expect(() => remarkPayload(payload, "remark:8", area)).toThrow();
  }
  for (const scope of [
    "organization",
    "project:2:daily-reports",
    "tool-tracking:2",
    "catalog:tools",
    "project:0",
  ]) {
    expect(() => remarkAreaFromScope(scope)).toThrow();
  }
  expect(remarkDomain("project:2:calculation")).toBe(false);
  expect(remarkDomain("tool:2:procurement")).toBe(false);
  for (const input of [
    { resourceType: "user", resourceId: "2" },
    { resourceType: "project", resourceId: "0" },
    { ...project, extra: true },
  ]) {
    expect(() => remarkResource(input)).toThrow();
  }
  for (const source of [
    noteRow(project, "0"),
    noteRow(project, "7", { project_id: null }),
    noteRow(project, "7", { customer_id: "2" }),
    noteRow(project, "7", { body: " " }),
    noteRow(project, "7", { created_by_user_id: "0" }),
    row("users"),
  ]) {
    expect(() =>
      remarkPayload(
        { format: "sortsys-remark-v1", row: source },
        "remark:7",
        remarkCollection(project),
      ),
    ).toThrow();
  }
  expect(remarkBody("  Text\n ")).toBe("Text");
  for (const input of [null, " ", "x\0y", "ä".repeat(5001)])
    expect(() => remarkBody(input)).toThrow();
});

test("all parent types support encrypted creation, narrow editing and signed deletion", async () => {
  const f = await fixture();
  try {
    for (const resource of resources) {
      const created = await f.store.mutate("remarks.create", {
        ...resource,
        body: "  " + body + "  ",
      });
      const [first] = await f.store.query("remarks.list", resource);
      expect(first.id).toBe(created.id);
      expect(first.body).toBe(body);
      expect(first.createdByUserId).toBe("1");
      await f.store.mutate("remarks.update", {
        id: created.id,
        body: body + " Geprüft.",
      });
      const [edited] = await f.store.query("remarks.list", resource);
      expect(edited.body).toBe(body + " Geprüft.");
      expect(edited.createdAt).toEqual(first.createdAt);
      expect(edited.createdByUserId).toBe(first.createdByUserId);
      await f.store.mutate("remarks.delete", { id: created.id });
      expect(await f.store.query("remarks.list", resource)).toEqual([]);
      expect(f.objects.get("remark:" + created.id).format).toBe(
        "sortsys-object-tombstone-v1",
      );
    }
    const sent = JSON.stringify(f.calls);
    expect(sent.includes("613945")).toBe(false);
    expect(sent.includes("Freigabe bestellen")).toBe(false);
    expect(f.calls.some((call) => call.path.startsWith("remarks."))).toBe(
      false,
    );
  } finally {
    f.store.close();
  }
});

test("catalogue notes remain assigned to their parent and sort by full timestamp then numeric ID", async () => {
  const f = await fixture();
  try {
    const customer = resources[1];
    const otherCustomer = { resourceType: "customer", resourceId: "3" };
    await f.seed(CUSTOMER_COLLECTION, "customer:3", {
      format: "sortsys-address-v1",
      kind: "customers",
      links: [],
      row: row("customers", {
        id: "3",
        name: "Zweiter Kunde",
        phone_numbers: "[]",
        email_addresses: "[]",
      }),
    });
    for (const source of [
      noteRow(customer, "7"),
      noteRow(customer, "8"),
      noteRow(customer, "9", { created_at: "2026-01-02T10:00:00.123455Z" }),
      noteRow(otherCustomer, "10"),
    ])
      await f.seedNote(source);
    expect(
      (await f.store.query("remarks.list", customer)).map((note) => note.id),
    ).toEqual(["8", "7", "9"]);
    expect(
      (await f.store.query("remarks.list", otherCustomer)).map(
        (note) => note.id,
      ),
    ).toEqual(["a"]);
  } finally {
    f.store.close();
  }
});

test("create, update and delete require independent parent grants even with the administrator role", async () => {
  for (const action of ["create", "update", "delete"]) {
    const f = await fixture(() => ["read", action]);
    f.state.roles = [":admin"];
    try {
      await f.seedNote(noteRow());
      const work = {
        create: () => f.store.mutate("remarks.create", { ...project, body }),
        update: () =>
          f.store.mutate("remarks.update", {
            id: "7",
            body: body + " Geprüft.",
          }),
        delete: () => f.store.mutate("remarks.delete", { id: "7" }),
      };
      for (const operation of ["create", "update", "delete"]) {
        if (operation === action) await work[operation]();
        else await expect(work[operation]()).rejects.toThrow();
      }
    } finally {
      f.store.close();
    }
  }
});

test("a grant for one project cannot read or edit another project's notes", async () => {
  const f = await fixture((area) =>
    area.scope === "project:3" ? [] : ["read", "create", "update", "delete"],
  );
  f.state.roles = [":admin"];
  try {
    await f.seedNote(noteRow(otherProject));
    await expect(f.store.query("remarks.list", otherProject)).rejects.toThrow();
    await expect(
      f.store.mutate("remarks.update", { id: "7", body }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("remarks.delete", { id: "7" }),
    ).rejects.toThrow();
    expect(await f.store.query("remarks.list", project)).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("missing, deleted or incorrectly bound parents never expose or accept notes", async () => {
  const f = await fixture();
  try {
    await f.seedNote(noteRow());
    await f.seed(
      f.projectArea,
      f.projectArea.prefix,
      projectPayload("2", true),
    );
    await expect(f.store.query("remarks.list", project)).rejects.toThrow();
    await expect(
      f.store.mutate("remarks.create", { ...project, body }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("remarks.update", { id: "7", body }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("remarks.delete", { id: "7" }),
    ).rejects.toThrow();
    await f.seed(remarkCollection(otherProject), "remark:8", {
      format: "sortsys-remark-v1",
      row: noteRow(project, "8"),
    });
    await expect(
      f.store.mutate("remarks.update", { id: "8", body }),
    ).rejects.toThrow();
    await expect(
      f.store.query("remarks.list", {
        resourceType: "customer",
        resourceId: "9",
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
});

test("source migration preserves original authors and microseconds and resumes without rewriting", async () => {
  const f = await fixture(undefined, true);
  try {
    const sources = resources.map((resource, index) =>
      noteRow(resource, String(index + 7)),
    );
    await copyRemarks(f.client, sources, f.controller.signal);
    const original = [...f.objects.entries()].map(([id, envelope]) => [
      id,
      structuredClone(envelope),
    ]);
    await copyRemarks(f.client, sources, f.controller.signal);
    expect([...f.objects.entries()]).toEqual(original);
    for (const source of sources) {
      const area = remarkCollection(remarkResourceFromRow(source));
      expect((await f.plain(area, remarkObject(source.values.id))).row).toEqual(
        source,
      );
    }
    await expect(
      copyRemarks(
        f.client,
        [noteRow(project, "7", { body: "Changed source" })],
        f.controller.signal,
      ),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
});

test("a concurrent parent deletion prevents note creation after a head conflict", async () => {
  const f = await fixture();
  let changed = false;
  try {
    f.state.beforeCommit = async () => {
      if (changed) return;
      changed = true;
      await f.seed(
        f.projectArea,
        f.projectArea.prefix,
        projectPayload("2", true),
      );
    };
    await expect(
      f.store.mutate("remarks.create", { ...project, body }),
    ).rejects.toThrow();
    expect([...f.objects.keys()].some((id) => id.startsWith("remark:"))).toBe(
      false,
    );
  } finally {
    f.store.close();
  }
});

test("a concurrent note edit is not silently overwritten by a retry", async () => {
  const f = await fixture();
  let changed = false;
  try {
    await f.seedNote(noteRow());
    f.state.beforeCommit = async () => {
      if (changed) return;
      changed = true;
      await f.seedNote(noteRow(project, "7", { body: "Concurrent result" }));
    };
    await expect(
      f.store.mutate("remarks.update", { id: "7", body: "Stale result" }),
    ).rejects.toThrow();
    expect(
      (await f.plain(remarkCollection(project), "remark:7")).row.values.body,
    ).toBe("Concurrent result");
  } finally {
    f.store.close();
  }
});

test("commit confirmation is verified instead of trusting a lost or false acknowledgement", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;
    const created = await f.store.mutate("remarks.create", {
      ...project,
      body,
    });
    expect(
      (await f.store.query("remarks.list", project)).map((note) => note.id),
    ).toEqual([created.id]);
    f.state.loseReply = false;
    f.state.discardCommit = true;
    await expect(
      f.store.mutate("remarks.update", { id: created.id, body: "Not stored" }),
    ).rejects.toThrow();
    expect((await f.store.query("remarks.list", project))[0].body).toBe(body);
  } finally {
    f.store.close();
  }
});

test("the application facade uses the encrypted remark adapter without plaintext RPC fallback", async () => {
  const f = await fixture();
  const business = createBusinessClient(f.client, {
    productDriver: duckDriver,
    realtime: false,
  });
  try {
    const [created, error] = await business.mutate("remarks.create", {
      ...project,
      body,
    });
    expect(error).toBeNull();
    const [listed, listError] = await business.query("remarks.list", project);
    expect(listError).toBeNull();
    expect(listed.map((note) => note.id)).toEqual([created.id]);
    expect(f.calls.some((call) => call.path.startsWith("remarks."))).toBe(
      false,
    );
  } finally {
    business.dispose();
    f.store.close();
  }
});

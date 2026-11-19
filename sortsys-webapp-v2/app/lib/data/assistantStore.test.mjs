import { afterEach, expect, test } from "bun:test";
import { signPolicy } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { privateLlmCollection } from "./assistantArea";
import { readAssistantAccess } from "./assistantStore";
import { createProtectedChats } from "./chats";
import {
  projectChatPaths,
  projectChatSection,
  visibleProjectChatResult,
} from "./chatProjectReads";
import { importHistory, readSelectedDocuments } from "./imports";
import { newAssistantId, openPrivateLlm } from "./privateLlm";
import { PRODUCT_COLLECTION } from "./products";
import { projectAccessArea } from "./projectScope";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { accessSnapshotFixture } from "./testing/accessSnapshot.mjs";

afterEach(() => lockCryptoSession());
const signal = () => new AbortController().signal;
const area = privateLlmCollection("user:1");

test("project chat reads require the current signed module grants and exclude attached photos", async () => {
  const permitted = [
    area,
    projectAccessArea("3", "daily-reports:master-data"),
    projectAccessArea("3", "regie-reports:master-data"),
    projectAccessArea("3", "delivery-notes:master-data"),
    projectAccessArea("3", "attachment"),
  ];
  const domains = new Set(permitted.map(({ domain }) => domain));
  const fixture = await protectedTenant(
    [
      ...permitted,
      projectAccessArea("3", "master-data"),
      projectAccessArea("4", "daily-reports:master-data"),
      projectAccessArea("3", "daily-reports:calculation"),
      projectAccessArea("3", "regie-reports:personnel"),
      projectAccessArea("3", "delivery-notes:procurement"),
    ],
    ({ domain }) => domains.has(domain) ? ["read", "create", "update"] : [],
  );
  fixture.state.roles = [":admin"];
  const access = await readAssistantAccess(fixture.client, signal(), "inventory");
  expect(projectChatPaths(access).sort()).toEqual([
    "deliveryNotes.get",
    "deliveryNotes.list",
    "projects.dailyReports.get",
    "projects.dailyReports.list",
    "regieReports.get",
    "regieReports.list",
  ]);

  const report = {
    projectId: "3",
    summary: "Fenster montiert",
    costRevision: "1",
    workHours: [{ hours: 4, costPerHour: 76 }],
    photos: [{ fileName: "Baustellenfoto.jpg" }],
  };
  const reports = projectChatSection("projects.dailyReports.list");
  const otherProject = { ...report, projectId: "4" };
  expect(visibleProjectChatResult(reports, [report, otherProject], access)).toEqual([
    {
      projectId: "3",
      summary: "Fenster montiert",
      workHours: [{ hours: 4, costPerHour: null }],
      photos: [],
    },
  ]);
  expect(() => visibleProjectChatResult(reports, otherProject, access)).toThrow();

  const regieReport = {
    projectId: "3",
    hoursRevision: "1",
    workHoursAvailable: true,
    workHours: [{ hours: 4 }],
  };
  expect(
    visibleProjectChatResult(projectChatSection("regieReports.get"), regieReport, access),
  ).toEqual({ projectId: "3", workHoursAvailable: false, workHours: [] });

  const delivery = {
    projectId: "3",
    priceRevision: "1",
    specialRecords: [{ amount: 4, pricePerUnit: 67 }],
  };
  expect(
    visibleProjectChatResult(projectChatSection("deliveryNotes.get"), delivery, access),
  ).toEqual({
    projectId: "3",
    specialRecords: [{ amount: 4, pricePerUnit: null }],
  });
});

function historyChat(client) {
  return createProtectedChats(client, client, "", signal(), async () => {
    throw new Error("History tests do not run directory searches");
  });
}

test("signed personal permissions open and update chat history without technical roles", async () => {
  const fixture = await protectedTenant([area]);
  expect(fixture.state.roles).toEqual([]);
  const chats = historyChat(fixture.client);
  const chat = await chats.create({
    title: "Privates Gespräch ohne Zusatzrolle",
  });
  expect((await chats.list()).map((value) => value.id)).toEqual([chat.id]);
  const reopened = historyChat(fixture.client);
  expect((await reopened.get(chat.id)).chat.title).toBe(
    "Privates Gespräch ohne Zusatzrolle",
  );
  await reopened.remove(chat.id);
  expect(await chats.list()).toEqual([]);
  expect(JSON.stringify([...fixture.objects.values()])).not.toContain(
    "Privates Gespräch ohne Zusatzrolle",
  );
});

test("personal read access preserves history but cannot run a model or change a chat", async () => {
  const fixture = await protectedTenant([area]);
  const writable = historyChat(fixture.client);
  const chat = await writable.create({
    title: "Bereits gespeicherter Verlauf",
  });
  const [current] = await fixture.client.query("zerotrust.policy.get");
  const { signature, ...previous } = current;
  const readOnlyPolicy = await signPolicy(
    {
      ...previous,
      version: "3",
      rules: previous.rules.map((rule) => ({ ...rule, actions: ["read"] })),
    },
    fixture.authorityKey.privateKey,
  );
  const client = {
    ...fixture.client,
    async query(path, input, options) {
      if (
        path === "zerotrust.access.snapshot" ||
        path === "zerotrust.access.page"
      )
        return accessSnapshotFixture(client, input);
      if (path === "zerotrust.policy.get") return [readOnlyPolicy, null];
      return fixture.client.query(path, input, options);
    },
  };
  const readOnly = historyChat(client);
  expect((await readOnly.get(chat.id)).chat.title).toBe(
    "Bereits gespeicherter Verlauf",
  );
  await expect(readAssistantAccess(client, signal())).rejects.toThrow();
  await expect(readOnly.remove(chat.id)).rejects.toThrow();
  expect((await readOnly.list()).map((value) => value.id)).toEqual([chat.id]);
});

test("scan history uses the same personal area without catalogue or delivery-note rights", async () => {
  const fixture = await protectedTenant([area]);
  const history = await openPrivateLlm(fixture.client, signal());
  try {
    await history.save("scan", newAssistantId(), {
      format: "sortsys-scan-v1",
      fileNames: ["Eigener Lieferschein.pdf"],
      createdAt: "2026-11-17T10:00:00Z",
      updatedAt: "2026-11-17T10:00:00Z",
      result: null,
      error: "Die Verarbeitung wurde unterbrochen.",
    });
  } finally {
    history.close();
  }
  const rows = await importHistory(fixture.client, signal());
  expect(rows).toHaveLength(1);
  expect(rows[0].fileName).toBe("Eigener Lieferschein.pdf");
  expect(rows[0].state).toBe("failed");
  const access = await readAssistantAccess(fixture.client, signal(), [
    PRODUCT_COLLECTION.domain,
  ]);
  expect(access.allows(PRODUCT_COLLECTION.scope, "master-data", "read")).toBe(
    false,
  );
});

for (const missing of ["read", "create", "update"]) {
  test(`a missing private ${missing} permission blocks a model request even for a technical administrator`, async () => {
    const fixture = await protectedTenant(
      [area, PRODUCT_COLLECTION],
      (selected) =>
        selected.domain === area.domain
          ? ["read", "create", "update"].filter((action) => action !== missing)
          : ["read"],
    );
    fixture.state.roles = [":admin", ":llm", "manage:deliveryNotes"];
    let prepared = false;
    await expect(
      readSelectedDocuments(fixture.client, "", [], signal(), () => {}, {
        async prepare() {
          prepared = true;
          throw new Error("The denied request must not prepare files");
        },
      }),
    ).rejects.toThrow();
    expect(prepared).toBe(false);
  });
}

test("catalogue denial prevents import preparation but does not revoke the personal assistant", async () => {
  const fixture = await protectedTenant([area]);
  let prepared = false;
  await expect(
    readSelectedDocuments(fixture.client, "", [], signal(), () => {}, {
      async prepare() {
        prepared = true;
        throw new Error("The denied request must not prepare files");
      },
    }),
  ).rejects.toThrow();
  expect(prepared).toBe(false);
  expect((await readAssistantAccess(fixture.client, signal())).subject).toBe(
    "user:1",
  );
});

test("an aborted assistant operation cannot open a personal collection", async () => {
  const fixture = await protectedTenant([area]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    openPrivateLlm(fixture.client, controller.signal),
  ).rejects.toThrow();
  expect(fixture.calls).toEqual([]);
});

import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  chromium,
  type Frame,
  type Page,
  type Route,
  type WebSocketRoute,
} from "playwright";
import { expect } from "playwright/test";
import type { Client } from "@sortsys/v2-client";
import type { AccessValue } from "../app/lib/crypto/accessProfiles";
import { changeProjectAccess } from "../app/lib/crypto/permissions";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import { fileObject } from "../app/lib/data/projectFileData";
import { applicationServer } from "./e2e/applicationServer.mjs";
import {
  changeDiagramLabel,
  diagramEditor,
  officeTestDiagram,
  officeTestDocument,
} from "./lib/officeTestPage";

const sourceText = "OFFICE_PERMISSION_SNAPSHOT_487562";
const reconnectEdit = "_OFFICE_BEFORE_API_INTERRUPTION_593816";
const failedSaveEdit = "_OFFICE_UNCONFIRMED_DURING_UPLOAD_219853";
const unconfirmedEdit = "_PENDING_OFFICE_EDIT_716204";
const fileName = "Vertrauliches Aufmaßprotokoll.docx";
const diagramName = "Vertraulicher Bauablauf beim Verbindungswechsel.drawio";
const diagramLabel = "DIAGRAM_BEFORE_SAVE_594821";
const diagramEdit = "DIAGRAM_RETRY_PROTECTED_594822";
const quantitiesName = "Vertrauliches Aufmaß.xlsx";
const quantitiesOriginal = "OFFICE_QUANTITIES_ORIGINAL_847216";
const quantitiesReplaced = "OFFICE_QUANTITIES_REPLACED_847216";
const sheetMime =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const mime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const officeTimeout = 120_000;

async function signIn(
  page: Page,
  app: string,
  username: string,
  password: string,
) {
  await page.goto(`${app}/auth/login`);
  await page
    .getByRole("textbox", { name: /^Nutzername/ })
    .fill(`${username}@editor-tenant`);
  await page.getByLabel(/^Passwort/).fill(password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Einstellungen", exact: true }),
  ).toBeVisible({ timeout: officeTimeout });
}

const officeFrame = (page: Page) =>
  page.locator('iframe[title="Dokumenteditor"]');
const pausedMessage = (page: Page) =>
  page.getByText(/^Verbindung unterbrochen\./);

async function interruptAutosaveUpload(
  page: Page,
  frame: Frame,
  edit: () => Promise<void>,
) {
  const upload = (url: URL) =>
    url.pathname.startsWith("/api/v2/") &&
    url.pathname.includes("zerotrust.fileChunks.putMany");
  let failedUploads = 0;
  const interrupt = async (route: Route) => {
    failedUploads++;
    await route.fulfill({ status: 503 });
  };
  await page.route(upload, interrupt);
  try {
    await edit();
    await expect
      .poll(() => failedUploads, { timeout: officeTimeout })
      .toBeGreaterThan(0);
    await expect(pausedMessage(page)).toBeVisible({ timeout: officeTimeout });
    assert.equal(frame.isDetached(), false);
  } finally {
    await page.unroute(upload, interrupt);
  }
}

async function officeEngine(
  page: Page,
  kind: "document" | "spreadsheet" = "document",
) {
  const isEngine = (frame: Frame) =>
    frame.url().includes(`/${kind}editor/main/`);
  await expect(officeFrame(page)).toBeVisible({ timeout: officeTimeout });
  return (
    page.frames().find(isEngine) ??
    (await page.waitForEvent("framenavigated", {
      predicate: isEngine,
      timeout: officeTimeout,
    }))
  );
}

async function quantitiesWorkbook(label: string, quantity: number) {
  const workbook = new ExcelJS.Workbook();
  const quantities = workbook.addWorksheet("Mengen");
  quantities.getCell("A1").value = label;
  quantities.getCell("B2").value = quantity;
  quantities.getCell("B3").value = { formula: "B2*2", result: quantity * 2 };
  workbook.addWorksheet("Übersicht").getCell("A1").value = {
    formula: "Mengen!B3",
    result: quantity * 2,
  };
  return new Blob([await workbook.xlsx.writeBuffer()], { type: sheetMime });
}

async function testSpreadsheetProjectFile(
  business: ReturnType<typeof createBusinessClient>,
  projectId: string,
  appOrigin: string,
  reader: Page,
  writer: Page,
) {
  const fileId = await business.files.upload({
    projectId,
    name: quantitiesName,
    mime: sheetMime,
    blob: await quantitiesWorkbook(quantitiesOriginal, 5),
  });
  const address = `${appOrigin}/projects/${projectId}/files/${fileId}`;
  const status = () => business.files.officeStatus(projectId, fileId);
  const cell = (frame: Frame) => frame.locator("#ce-cell-content");

  await reader.goto(address);
  const first = await officeEngine(reader, "spreadsheet");
  await expect(cell(first)).toHaveValue(quantitiesOriginal, {
    timeout: officeTimeout,
  });
  assert.equal((await status()).epoch, null);

  const replacement = await business.files.save(
    projectId,
    fileId,
    1n,
    await quantitiesWorkbook(quantitiesReplaced, 7),
  );
  assert.equal(replacement.version, 2n);
  assert.equal((await status()).epoch, null);
  await expect
    .poll(() => first.isDetached(), { timeout: officeTimeout })
    .toBe(true);
  await expect(reader).toHaveURL(address);
  const second = await officeEngine(reader, "spreadsheet");
  await expect(cell(second)).toHaveValue(quantitiesReplaced, {
    timeout: officeTimeout,
  });
  console.log(
    "Office permissions: an independent XLSX reader followed the confirmed file replacement",
  );

  await writer.goto(address);
  const editable = await officeEngine(writer, "spreadsheet");
  await expect(cell(editable)).toHaveValue(quantitiesReplaced, {
    timeout: officeTimeout,
  });
  const room = await status();
  assert.ok(room.epoch);
  await expect
    .poll(() => second.isDetached(), { timeout: officeTimeout })
    .toBe(true);
  await officeEngine(reader, "spreadsheet");

  const range = editable.locator("#ce-cell-name");
  await range.fill("B2");
  await range.press("Enter");
  await expect(cell(editable)).toHaveValue("7");
  await cell(editable).selectText();
  await cell(editable).pressSequentially("9");
  await cell(editable).press("Enter");
  await expect
    .poll(async () => {
      const saved = await business.files.blob(projectId, fileId);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await saved.arrayBuffer());
      const quantities = workbook.getWorksheet("Mengen");
      const overview = workbook.getWorksheet("Übersicht");
      return {
        quantity: quantities?.getCell("B2").value,
        formula: quantities?.getCell("B3").formula,
        total: overview?.getCell("A1").result,
      };
    }, { timeout: officeTimeout })
    .toEqual({ quantity: 9, formula: "B2*2", total: 18 });
  assert.equal((await status()).epoch, room.epoch);
  console.log(
    "Office permissions: XLSX keyboard autosave confirmed the recalculated workbook in encrypted project storage",
  );
}

function observePlaintext(page: Page, leaks: string[]) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v2/")) return;
    const payload = [decodeURIComponent(url.search), request.postData() ?? ""];
    for (const marker of [
      sourceText,
      reconnectEdit,
      failedSaveEdit,
      unconfirmedEdit,
      fileName,
      diagramName,
      diagramLabel,
      diagramEdit,
      quantitiesName,
      quantitiesOriginal,
      quantitiesReplaced,
    ]) {
      if (payload.some((value) => value.includes(marker))) leaks.push(marker);
    }
  });
}

export async function testOfficeRevocation({
  owner,
  business,
  memberEndpoint,
  memberId,
  projectId,
  signal,
}: {
  owner: Client;
  business: ReturnType<typeof createBusinessClient>;
  memberEndpoint: string;
  memberId: string;
  projectId: string;
  signal: AbortSignal;
}) {
  assert.equal(process.env.SORTSYS_DISPOSABLE_OFFICE_TEST, "1");
  const office = new URL(process.env.SORTSYS_OFFICE_TEST_ORIGIN ?? "");
  assert.equal(office.hostname, "127.0.0.1");
  assert.equal(office.protocol, "http:");
  const port = Number(process.env.SORTSYS_OFFICE_APP_PORT);
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535);
  const build =
    process.env.SORTSYS_E2E_APPLICATION_BUILD ??
    new URL("../build/client", import.meta.url).pathname;
  const grant = (access: AccessValue) =>
    changeProjectAccess(
      owner,
      `user:${memberId}`,
      projectId,
      access,
      signal,
      "attachment",
    );
  await grant({ actions: ["read", "update"] });
  const fileId = await business.files.upload({
    projectId,
    name: fileName,
    mime,
    blob: new Blob([await officeTestDocument(sourceText)], { type: mime }),
  });
  const fileStatus = () => business.files.officeStatus(projectId, fileId);
  async function savedText() {
    const file = await business.files.office(projectId, fileId);
    const zip = await JSZip.loadAsync(await file.document.arrayBuffer());
    return (await zip.file("word/document.xml")!.async("string")).replace(
      /<[^>]*>/g,
      "",
    );
  }

  const app = await applicationServer(build, memberEndpoint, { port });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const releaseSave = Promise.withResolvers<void>();
  try {
    browser = await chromium.launch({
      executablePath: process.env.SORTSYS_E2E_CHROMIUM,
    });
    const leaks: string[] = [];
    const member = await (
      await browser.newContext({ locale: "de-DE" })
    ).newPage();
    observePlaintext(member, leaks);
    let apiSocket: WebSocketRoute | undefined;
    let readySockets = 0;
    await member.routeWebSocket(
      (url) => url.pathname === "/api/v2/zerotrust/events",
      (socket) => {
        apiSocket = socket;
        const upstream = socket.connectToServer();
        upstream.onMessage((message) => {
          if (
            typeof message === "string" &&
            JSON.parse(message)?.type === "ready"
          )
            readySockets++;
          socket.send(message);
        });
      },
    );
    const path = `${app.origin}/projects/${projectId}/files/${fileId}`;
    await signIn(
      member,
      app.origin,
      "editor.member",
      "Private-editor-member-password-2026!",
    );
    await member.goto(path);
    const writer = await officeEngine(member);
    const opened = await fileStatus();
    assert.ok(opened.epoch);
    const initial = await savedText();
    assert.ok(initial.includes(sourceText));
    assert.ok(!initial.includes(unconfirmedEdit));
    console.log("Office permissions: actual editor ready with write access");

    const input = writer.locator("#area_id");
    await input.press("Control+End");
    await input.pressSequentially(reconnectEdit);
    const attachmentDomain = `project:${projectId}:attachment`;
    const accessSnapshot = (url: URL) =>
      url.pathname.startsWith("/api/v2/") &&
      url.pathname.includes("zerotrust.access.snapshot");
    let failedChecks = 0;
    const interruptAccess = async (route: Route) => {
      const query = new URL(route.request().url()).searchParams.get("input");
      const body = route.request().postData();
      if (
        !query?.includes(attachmentDomain) &&
        !body?.includes(attachmentDomain)
      ) {
        return route.continue();
      }
      failedChecks++;
      await route.abort("internetdisconnected");
    };
    await member.route(accessSnapshot, interruptAccess);
    try {
      await member.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(pausedMessage(member)).toBeVisible({ timeout: officeTimeout });
      assert.ok(failedChecks > 0);
      assert.equal(writer.isDetached(), false);
      await expect(
        member.locator("div.project-files-office-editor"),
      ).toHaveAttribute("inert", "");
      const previous = apiSocket;
      assert.ok(previous);
      const before = readySockets;
      await previous.close({ code: 1001 });
      await expect
        .poll(() => readySockets, { timeout: officeTimeout })
        .toBeGreaterThan(before);
      assert.equal(writer.isDetached(), false);
    } finally {
      await member.unroute(accessSnapshot, interruptAccess);
    }
    await expect(pausedMessage(member)).toHaveCount(
      0,
      {
        timeout: officeTimeout,
      },
    );
    assert.equal(writer.isDetached(), false);
    await expect
      .poll(savedText, { timeout: officeTimeout })
      .toContain(reconnectEdit);
    await expect(member).toHaveURL(path);
    console.log(
      "Office permissions: the same editor saved its draft after reconnecting to the API",
    );

    await interruptAutosaveUpload(member, writer, () =>
      input.pressSequentially(failedSaveEdit),
    );
    await expect
      .poll(savedText, { timeout: officeTimeout })
      .toContain(failedSaveEdit);
    assert.ok((await savedText()).includes(reconnectEdit));
    assert.equal(writer.isDetached(), false);
    const confirmed = await fileStatus();
    assert.equal(confirmed.epoch, opened.epoch);
    console.log(
      "Office permissions: a failed upload was followed by a fresh editor snapshot",
    );

    const fileKey = fileObject(projectId, fileId);
    let waiting = false;
    let saveReply: string | undefined;
    await member.route(
      (url) =>
        url.pathname.startsWith("/api/v2/") &&
        url.pathname
          .slice("/api/v2/".length)
          .split(",")
          .includes("zerotrust.objects.batch"),
      async (route) => {
        // Match only the autosave for this file. Room creation is already committed.
        const entries = Object.values(
          route.request().postDataJSON() as Record<
            string,
            { json?: { objects?: { envelope?: { object?: string } }[] } }
          >,
        );
        const index = entries.findIndex((entry) =>
          entry.json?.objects?.some(
            ({ envelope }) => envelope?.object === fileKey,
          ),
        );
        if (waiting || index < 0) return route.continue();
        waiting = true;
        await releaseSave.promise;
        try {
          const response = await route.fetch();
          const results = await response.json();
          saveReply = results[index]?.error?.json?.data?.code ?? "accepted";
          await route.fulfill({ response }).catch(() => {
            // The app may have already closed the old frame.
          });
        } catch (error) {
          saveReply = String(error);
          await route.abort().catch(() => undefined);
        }
      },
    );
    await input.press("Control+End");
    await input.pressSequentially(unconfirmedEdit);
    await expect.poll(() => waiting, { timeout: officeTimeout }).toBe(true);

    await grant("read");
    await expect
      .poll(() => writer.isDetached(), { timeout: officeTimeout })
      .toBe(true);
    await expect(member).toHaveURL(path);
    releaseSave.resolve();
    await expect
      .poll(() => saveReply, { timeout: officeTimeout })
      .toMatch(/^(CONFLICT|FORBIDDEN)$/);
    const after = await fileStatus();
    assert.equal(after.contentVersion, confirmed.contentVersion);
    assert.equal(after.previousSession?.epoch, confirmed.epoch);
    assert.ok(!(await savedText()).includes(unconfirmedEdit));
    const reader = await officeEngine(member);
    assert.notEqual(reader, writer);
    console.log(
      "Office permissions: downgrade closed the writer and rejected its pending autosave",
    );

    const administrator = await (
      await browser.newContext({ locale: "de-DE" })
    ).newPage();
    observePlaintext(administrator, leaks);
    await signIn(
      administrator,
      app.origin,
      "builder",
      "Private-editor-owner-password-2026!",
    );
    await administrator.goto(path);
    const adopt = administrator.getByRole("button", {
      name: "Bearbeitungsstand übernehmen",
      exact: true,
    });
    await expect(adopt).toBeEnabled({ timeout: officeTimeout });
    await adopt.click();
    await expect
      .poll(async () => (await savedText()).includes(unconfirmedEdit), {
        timeout: officeTimeout,
      })
      .toBe(true);
    assert.notEqual((await fileStatus()).epoch, confirmed.epoch);
    await expect
      .poll(() => reader.isDetached(), { timeout: officeTimeout })
      .toBe(true);
    const replacement = await officeEngine(member);
    console.log(
      "Office permissions: explicit draft approval published the content in a new room",
    );

    await grant("none");
    await expect
      .poll(() => replacement.isDetached(), { timeout: officeTimeout })
      .toBe(true);
    await expect(officeFrame(member)).toHaveCount(0, {
      timeout: officeTimeout,
    });
    console.log("Office permissions: full revocation closed the live reader");

    await grant({ actions: ["read", "update"] });
    const diagramId = await business.files.upload({
      projectId,
      name: diagramName,
      mime: "application/vnd.jgraph.mxfile",
      blob: new Blob([officeTestDiagram(diagramLabel)]),
    });
    await member.goto(`${app.origin}/projects/${projectId}/files/${diagramId}`);
    const diagram = await diagramEditor(member);
    const before = await business.files.officeStatus(projectId, diagramId);
    assert.ok(before.epoch);
    await interruptAutosaveUpload(member, diagram, () =>
      changeDiagramLabel(diagram, diagramLabel, diagramEdit),
    );
    await expect
      .poll(async () => {
        const saved = await business.files.blob(projectId, diagramId);
        return (await saved.text()).includes(diagramEdit);
      }, { timeout: officeTimeout })
      .toBe(true);
    assert.equal(diagram.isDetached(), false);
    const afterDiagramSave = await business.files.officeStatus(projectId, diagramId);
    assert.equal(afterDiagramSave.epoch, before.epoch);
    assert.ok(
      BigInt(afterDiagramSave.contentVersion) > BigInt(before.contentVersion),
    );
    console.log("Office permissions: the same Drawio editor confirmed its edit after the failed upload");
    await grant("read");
    await testSpreadsheetProjectFile(
      business,
      projectId,
      app.origin,
      member,
      administrator,
    );
    assert.deepEqual(leaks, []);
  } finally {
    releaseSave.resolve();
    try {
      await browser?.close();
    } finally {
      await app.close();
    }
  }
}

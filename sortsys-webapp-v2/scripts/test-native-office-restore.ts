import assert from "node:assert/strict";
import JSZip from "jszip";
import { chromium, type Browser, type Page } from "playwright";
import { expect } from "playwright/test";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import {
  changeDiagramLabel,
  diagramEditor,
  officeTestDiagram,
  officeTestDocument,
  serveOfficeTestPage,
} from "./lib/officeTestPage";

type Files = ReturnType<typeof createBusinessClient>["files"];
const examples = {
  doc: {
    name: "Vertrauliche Besprechung.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    initial: "PRIVATE_OFFICE_RESTORE_801146",
    edit: "EDIT_IN_RESTORED_OFFICE_420169",
  },
  diagram: {
    name: "Vertraulicher Bauablauf.drawio",
    mime: "application/vnd.jgraph.mxfile",
    format: "drawio",
    initial: "PRIVATE_DIAGRAM_RESTORE_670917",
    edit: "EDIT_IN_RESTORED_DIAGRAM_715580",
  },
} as const;
type Kind = keyof typeof examples;
export type RestoredOfficeRoom = {
  kind: Kind;
  file: string;
  epoch: string;
  version: string;
};

async function localBytes(kind: Kind) {
  if (kind === "doc") return officeTestDocument(examples.doc.initial);
  return officeTestDiagram(examples.diagram.initial);
}

async function text(kind: Kind, source: Blob | Uint8Array<ArrayBuffer>) {
  const bytes =
    source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
  if (kind === "diagram") return new TextDecoder().decode(bytes);
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file("word/document.xml")!.async("string")).replace(
    /<[^>]*>/g,
    "",
  );
}

function includesExpectedEdit(kind: Kind, value: string) {
  const { initial, edit } = examples[kind];
  if (!value.includes(edit)) return false;
  return kind === "doc" ? value.includes(initial) : !value.includes(initial);
}

async function withOfficeBrowser<T>(
  run: (browser: Browser, app: string, origin: string) => Promise<T>,
) {
  assert.equal(process.env.SORTSYS_DISPOSABLE_OFFICE_TEST, "1");
  const origin = process.env.SORTSYS_OFFICE_TEST_ORIGIN ?? "";
  const port = Number(process.env.SORTSYS_OFFICE_APP_PORT);
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535);
  const server = await serveOfficeTestPage(port);
  try {
    const browser = await chromium.launch({
      executablePath: process.env.SORTSYS_E2E_CHROMIUM,
    });
    try {
      return await run(browser, server.url.origin, origin);
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
}

async function startEditor(
  page: Page,
  app: string,
  office: Awaited<ReturnType<Files["office"]>>,
  kind: Kind,
  editing: boolean,
) {
  await page.goto(app);
  await page.waitForFunction(() => typeof window.startOffice === "function");
  await page.evaluate(
    ({ bytes, origin, name, application, editing, accessKey, viewKey }) => {
      window.officeTest.holdSaves = true;
      window.startOffice(bytes, origin, {
        application,
        fileName: name,
        canEdit: editing,
        accessKey,
        viewKey,
      });
    },
    {
      bytes: Array.from(new Uint8Array(await office.document.arrayBuffer())),
      origin: office.editorOrigin,
      name: office.fileName,
      application: kind,
      editing,
      accessKey: editing ? office.accessKey : office.viewKey,
      viewKey: office.viewKey,
    },
  );
  await page.waitForFunction(
    () => window.officeTest.ready || window.officeTest.errors > 0,
    undefined,
    { timeout: 120_000 },
  );
  assert.equal(await page.evaluate(() => window.officeTest.errors), 0);
}

async function editInRoom(page: Page, kind: Kind) {
  const example = examples[kind];
  if (kind === "doc") {
    const document = page.frames().find((frame) =>
      frame.url().includes("/documenteditor/main/"),
    );
    assert.ok(document);
    const editor = document.locator("#area_id");
    await editor.press("Control+End");
    await editor.pressSequentially(example.edit);
    return;
  }
  await changeDiagramLabel(await diagramEditor(page), example.initial, example.edit);
}

export async function prepareOfficeRooms(files: Files, project: string) {
  return withOfficeBrowser(async (browser, app, origin) => {
    const rooms: RestoredOfficeRoom[] = [];
    for (const kind of ["doc", "diagram"] as const) {
      const example = examples[kind];
      const original = await localBytes(kind);
      const file = await files.upload({
        projectId: project,
        name: example.name,
        mime: example.mime,
        blob: new Blob([original], { type: example.mime }),
      });
      const office = await files.office(project, file);
      assert.equal(office.editorOrigin, origin);
      assert.equal(office.epoch, null);
      assert.equal(office.canEdit, true);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.exposeFunction(
          "publishOfficeRoom",
          (
            previous: string | null,
            proposed: { editKey: string; viewKey: string },
          ) =>
            files.publishOfficeSession(
              project,
              file,
              previous ?? undefined,
              proposed,
            ),
        );
        await startEditor(page, app, office, kind, true);
        await editInRoom(page, kind);
        await expect
          .poll(
            async () => {
              const pending = await page.evaluate(() =>
                window.officeTest.pending.at(-1),
              );
              return (
                !!pending &&
                includesExpectedEdit(
                  kind,
                  await text(kind, new Uint8Array(pending)),
                )
              );
            },
            { timeout: 60_000 },
          )
          .toBe(true);

        const published = await files.officeStatus(project, file);
        assert.ok(published.epoch && published.viewKey);
        assert.equal(published.contentVersion, office.contentVersion);
        const stored = await files.blob(project, file);
        assert.ok(
          Buffer.from(await stored.arrayBuffer()).equals(Buffer.from(original)),
        );
        rooms.push({
          kind,
          file,
          epoch: published.epoch,
          version: published.contentVersion,
        });
        console.log(
          `Published a real ${kind} room and verified its draft is ahead of its project file`,
        );
      } finally {
        await context.close();
      }
    }
    return rooms;
  });
}

export async function restoreOfficeRooms(
  files: Files,
  project: string,
  rooms: readonly RestoredOfficeRoom[],
) {
  await withOfficeBrowser(async (browser, app, origin) => {
    for (const room of rooms) {
      const example = examples[room.kind];
      const office = await files.office(project, room.file);
      assert.equal(office.editorOrigin, origin);
      assert.equal(office.epoch, room.epoch);
      assert.equal(office.contentVersion, room.version);
      assert.ok(office.viewKey);
      assert.ok(!(await text(room.kind, office.document)).includes(example.edit));
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.exposeFunction("publishOfficeRoom", () => {
          throw new Error("A view-only restoration tried to publish another room");
        });
        await startEditor(page, app, office, room.kind, false);
        const bytes = await page.evaluate(
          async (format) => {
            const blob = await window.officeTest.bridge!.export(format);
            return Array.from(new Uint8Array(await blob.arrayBuffer()));
          },
          example.format,
        );
        const exported = new Blob([new Uint8Array(bytes)], { type: example.mime });
        assert.ok(
          includesExpectedEdit(room.kind, await text(room.kind, exported)),
        );
        assert.equal(await page.evaluate(() => window.officeTest.session), null);
        const confirmed = await files.saveOffice(
          project,
          room.file,
          room.epoch,
          BigInt(room.version),
          exported,
        );
        assert.equal(confirmed.version, BigInt(room.version) + 1n);
        const saved = await files.blob(project, room.file);
        assert.ok(
          Buffer.from(await saved.arrayBuffer()).equals(Buffer.from(bytes)),
        );
        console.log(
          `Recovered and confirmed the draft from the copied ${room.kind} room`,
        );
      } finally {
        await context.close();
      }
    }
  });
}

export async function checkCommittedOfficeFiles(
  files: Files,
  project: string,
  rooms: readonly RestoredOfficeRoom[],
) {
  for (const room of rooms) {
    const file = await files.blob(project, room.file);
    assert.ok(includesExpectedEdit(room.kind, await text(room.kind, file)));
    const status = await files.officeStatus(project, room.file);
    assert.equal(BigInt(status.contentVersion), BigInt(room.version) + 1n);
  }
}

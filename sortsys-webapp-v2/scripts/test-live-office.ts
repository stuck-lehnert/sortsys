/** Opt-in integration against an owned, disposable CryptPad installation. */
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { spawnSync } from "bun";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Page,
  type Request,
} from "playwright";
import { observeWorkerTraffic } from "./lib/workerTraffic";
import { officeTestDocument, serveOfficeTestPage } from "./lib/officeTestPage";
import { createBlankProjectFile } from "../app/lib/blankProjectFiles";

if (process.env.SORTSYS_DISPOSABLE_OFFICE_TEST !== "1")
  throw new Error("A disposable Office test installation is required");
const origin = process.env.SORTSYS_OFFICE_TEST_ORIGIN ?? "";
if (!origin || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/.test(origin)) {
  throw new Error("An explicit loopback Office test origin is required");
}
const initial = "SORTSYS_PRIVATE_OFFICE_TEST_20261109";
const edit = "_EDITED_IN_BROWSER";
const peerEdit = "_SECOND_COLLABORATOR";
const unconfirmedDraft = "_UNCONFIRMED_DRAFT_FOR_REKEY";
const oldRoomEdit = "_OLD_ROOM_AFTER_REKEY";
const presentationName = "Baustellenbesprechung.pptx";
const presentationText = "VERTRAULICHER_FOLIENTEXT_73451";
const diagramInitialA = "SORTSYS_PRIVATE_DIAGRAM_A";
const diagramInitialB = "SORTSYS_PRIVATE_DIAGRAM_B";
const diagramEditA = "SORTSYS_PRIVATE_DIAGRAM_EDIT_A";
const diagramEditB = "SORTSYS_PRIVATE_DIAGRAM_EDIT_B";
const diagramFileName = "Privater-Bauablauf.drawio";
const planImage =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNIMLgARww4OQA8thCB8fEjXwAAAABJRU5ErkJggg==";
const detailImage =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGN4MEHxwQRFAAx8AyPyTiS5AAAAAElFTkSuQmCC";
const diagramDetailPage = "SORTSYS_PRIVATE_DIAGRAM_DETAIL";
const privateMarkers = [
  initial,
  edit,
  peerEdit,
  unconfirmedDraft,
  oldRoomEdit,
  "Proof.docx",
  "MENGEN_PRIVATE_OFFICE",
  "Mengen.xlsx",
  presentationName,
  presentationText,
  diagramInitialA,
  diagramInitialB,
  diagramEditA,
  diagramEditB,
  diagramFileName,
  diagramDetailPage,
  planImage,
  detailImage,
];

function diagramImageCell(id: string, png: string) {
  return `<mxCell id="${id}" style="shape=image;image=data:image/png,${png}" vertex="1" parent="1">
    <mxGeometry x="100" y="200" width="160" height="100" as="geometry"/>
  </mxCell>`;
}

async function waitForSharedDiagramExport(page: Page) {
  // The graph frame can show remote edits before the room can export them.
  const deadline = performance.now() + 15_000;
  do {
    const xml = await page.evaluate(async () =>
      (await window.officeTest.bridge!.export("drawio")).text(),
    );
    if (xml.includes(diagramEditA) && xml.includes(diagramEditB)) return xml;
    await Bun.sleep(250);
  } while (performance.now() < deadline);

  throw new Error("The native diagram export did not include both shared edits");
}

async function checkSharedDiagram(page: Page, xml: string) {
  const result = await page.evaluate((xml) => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    return {
      pages: [...document.querySelectorAll("diagram")].map((page) => ({
        id: page.getAttribute("id"),
        name: page.getAttribute("name"),
        images: [...page.querySelectorAll("mxCell[style]")]
          .map(
            (cell) =>
              cell.getAttribute("style")?.match(/(?:^|;)image=([^;]+)/)?.[1],
          )
          .filter(Boolean),
      })),
      labels: [...document.querySelectorAll("mxCell[value]")].map(
        (cell) => cell.getAttribute("value"),
      ),
    };
  }, xml);
  assert.deepEqual(result.pages, [
    {
      id: "construction",
      name: "Bauablauf",
      images: [`data:image/png,${planImage}`],
    },
    {
      id: "detail",
      name: diagramDetailPage,
      images: [`data:image/png,${detailImage}`],
    },
  ]);
  assert.ok(
    result.labels.includes(diagramEditA) && result.labels.includes(diagramEditB),
  );
}

async function waitForDiagramImage(frame: Frame, png: string) {
  await frame.waitForFunction(
    (expected) => {
      const images = document.querySelectorAll(".geDiagramContainer svg image");
      return [...images].some((image) => {
        const source = image.getAttribute("xlink:href") ?? image.getAttribute("href");
        return source === expected;
      });
    },
    `data:image/png;base64,${png}`,
  );
}

const original = await officeTestDocument(initial);
const server = await serveOfficeTestPage(
  Number(process.env.SORTSYS_OFFICE_APP_PORT ?? 0),
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workerTraffic: Awaited<ReturnType<typeof observeWorkerTraffic>> | undefined;
try {
  browser = await chromium.launch({
    args: ["--remote-debugging-port=0", "--enable-automation"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics: string[] = [];
  const observePage = (page: Page, label: string) => {
    page.on("pageerror", (error) =>
      diagnostics.push(`${label}: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message
        .text()
        .replace(/cryptpad:\/\/[^\s'"]+/g, "[image reference]");
      diagnostics.push(`${label}: ${text.slice(0, 500)}`);
    });
    page.on("requestfailed", (request) =>
      diagnostics.push(
        `${label}: ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
      ),
    );
  };
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) =>
    diagnostics.push((error.stack ?? error.message).slice(0, 1200)),
  );
  page.on("requestfailed", (request) =>
    diagnostics.push(
      `${new URL(request.url()).pathname}: ${request.failure()?.errorText}`,
    ),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      diagnostics.push(
        `${new URL(response.url()).pathname}: HTTP ${response.status()}`,
      );
  });
  const forbidden: string[] = [];
  const leaks: string[] = [];
  const sentUrls: string[] = [];
  const sentFrames: Buffer[] = [];
  const sentBodies: Buffer[] = [];
  const navigationUrls = new WeakMap<BrowserContext, Set<string>>();
  let sentFrameBytes = 0;
  let workerFrameCount = 0;
  let capturedBytes = 0;
  let captureOverflow = false;
  const maxCapturedBytes = 64 * 1024 * 1024;
  function capturePayload(target: Buffer[], bytes: Buffer) {
    capturedBytes += bytes.length;
    if (capturedBytes <= maxCapturedBytes) {
      target.push(bytes);
    } else {
      captureOverflow = true;
    }
  }
  function containsText(
    bytes: Buffer | null | undefined,
    text: string,
  ): boolean {
    return (
      !!bytes &&
      (bytes.includes(Buffer.from(text)) ||
        bytes.includes(Buffer.from(text, "utf16le")))
    );
  }
  function observeEditorContext(context: BrowserContext) {
    context.on("request", observeRequest);
    const urls = new Set<string>();
    navigationUrls.set(context, urls);
    const observePageTraffic = (page: import("playwright").Page) => {
      page.on("framenavigated", (frame) => urls.add(frame.url()));
      page.on("websocket", (socket) => {
        sentUrls.push(socket.url());
        socket.on("framesent", ({ payload }) => {
          const bytes =
            typeof payload === "string" ? Buffer.from(payload) : payload;
          observeFrame(bytes);
        });
      });
    };
    context.on("page", observePageTraffic);
    for (const page of context.pages()) {
      observePageTraffic(page);
    }
  }
  function observeFrame(bytes: Buffer) {
    sentFrameBytes += bytes.length;
    capturePayload(sentFrames, bytes);
    for (const marker of privateMarkers) {
      if (containsText(bytes, marker)) {
        leaks.push("plaintext-websocket-frame");
      }
    }
  }
  workerTraffic = await observeWorkerTraffic(browser, {
    socket: (url) => sentUrls.push(url),
    frame: (bytes) => {
      workerFrameCount++;
      observeFrame(bytes);
    },
  });
  let uploads = 0;
  const observeRequest = (request: Request) => {
    const url = new URL(request.url());
    sentUrls.push(request.url());
    if (
      /\/ooapidl|\/oosave|\/ConvertService|\/coauthoring\/CommandService/.test(
        url.pathname,
      )
    )
      forbidden.push(url.pathname);
    const body = request.postDataBuffer();
    if (body) {
      capturePayload(sentBodies, body);
    }
    for (const text of privateMarkers) {
      if (url.search.includes(text) || containsText(body, text))
        leaks.push(url.pathname);
    }
    if (url.pathname.startsWith("/upload-blob/") && body) {
      const packet = JSON.parse(body.toString()),
        encrypted = Buffer.from(packet.chunk, "base64");
      uploads++;
      capturePayload(sentBodies, encrypted);
      for (const text of privateMarkers)
        if (containsText(encrypted, text))
          leaks.push("decrypted-looking-upload");
    }
  };
  observeEditorContext(context);
  const auxiliaries: BrowserContext[] = [];
  type EditorSettings = NonNullable<Parameters<Window["startOffice"]>[2]>;

  async function openOfficeFile(
    bytes: number[],
    settings: EditorSettings,
    label: string,
  ) {
    const editorContext = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
    });
    auxiliaries.push(editorContext);
    observeEditorContext(editorContext);
    const editorPage = await editorContext.newPage();
    observePage(editorPage, label);
    await editorPage.goto(server.url.href);
    await editorPage.waitForFunction(
      () => typeof window.startOffice === "function",
    );
    await editorPage.evaluate(
      ({ bytes, origin, settings }) =>
        window.startOffice(bytes, origin, settings),
      { bytes, origin, settings },
    );
    await editorPage.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120_000 },
    );
    assert.equal(
      await editorPage.evaluate(() => window.officeTest.errors),
      0,
      label,
    );
    return editorPage;
  }

  function exportOfficeFile(page: Page, format: "xlsx" | "pptx" | "pdf") {
    return page.evaluate(async (format) => {
      const file = await window.officeTest.bridge!.export(format);
      return Array.from(new Uint8Array(await file.arrayBuffer()));
    }, format);
  }

  async function nextAutosave(page: Page, previousCount: number) {
    await page.waitForFunction(
      (count) => window.officeTest.saved.length > count,
      previousCount,
      { timeout: 35_000 },
    );
    return page.evaluate((index) => window.officeTest.saved[index]!, previousCount);
  }

  const documentText = async (bytes: number[]) => {
    const saved = await JSZip.loadAsync(new Uint8Array(bytes));
    return (await saved.file("word/document.xml")!.async("string")).replace(
      /<[^>]*>/g,
      "",
    );
  };
  async function assertPrivateBrowserState(
    context: BrowserContext,
    capabilities: string[] = [],
  ) {
    const stored = JSON.stringify(
      await context.storageState({ indexedDB: true, opfs: true }),
    );
    const secrets = [...privateMarkers];
    for (const capability of capabilities) {
      secrets.push(capability, capability.split("/").filter(Boolean).at(-1)!);
    }
    for (const secret of secrets) {
      assert.ok(
        !stored.includes(secret),
        "Private document contents or room capabilities persisted in browser storage",
      );
    }
    const observed = navigationUrls.get(context);
    assert.ok(observed?.size, "The editor navigation check must observe frames");
    const urls = new Set(observed);
    for (const page of context.pages()) {
      for (const frame of page.frames()) urls.add(frame.url());
      const protocol = await context.newCDPSession(page);
      try {
        const { entries } = await protocol.send("Page.getNavigationHistory");
        for (const entry of entries) {
          urls.add(entry.url);
          urls.add(entry.userTypedURL);
        }
      } finally {
        await protocol.detach();
      }
    }
    for (const url of urls) {
      let decoded = url;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        // Also check the raw URL if it has a malformed escape sequence.
      }
      assert.ok(
        secrets.every(
          (secret) => !decoded.includes(secret) && !url.includes(secret),
        ),
        "Private document contents or room capabilities appeared in frame URLs or browser history",
      );
    }
  }
  try {
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof window.startOffice === "function");
    await page.evaluate(
      ({ bytes, origin }) => window.startOffice(bytes, origin),
      { bytes: Array.from(original), origin },
    );
    await page.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120000 },
    );
    assert.equal(
      await page.evaluate(() => window.officeTest.errors),
      0,
      "The real editor reported a startup error",
    );
    const openedRoom = await page.evaluate(() => window.officeTest.session);
    assert.ok(openedRoom);
    await assertPrivateBrowserState(context, [
      openedRoom.editKey,
      openedRoom.viewKey,
    ]);
    await page.waitForFunction(
      () => window.officeTest.saved.length > 0,
      undefined,
      { timeout: 30000 },
    );
    const previous = await page.evaluate(() => window.officeTest.saved.length);
    const frame = page
      .frames()
      .find((frame) => frame.url().includes("/documenteditor/main/"));
    assert.ok(frame, "The real browser editor must be loaded");
    await frame.locator("#area_id").press("Control+End");
    await page.keyboard.type(edit);
    await page.waitForFunction(
      (count) => window.officeTest.saved.length > count,
      previous,
      { timeout: 30000 },
    );
    const result = await page.evaluate(() => ({
      errors: window.officeTest.errors,
      bytes: window.officeTest.saved.at(-1)!,
      session: window.officeTest.session!,
    }));
    assert.equal(result.errors, 0);
    const text = await documentText(result.bytes);
    assert.ok(
      text.includes(initial),
      "The original text must survive conversion",
    );
    assert.ok(
      text.includes(edit),
      "The keyboard edit must reach the autosaved DOCX",
    );
    console.log("Office proof: original DOCX and keyboard autosave verified");
    // Office locks the paragraph currently being edited. Move the first
    // collaborator to the other paragraph before the peer edits the last one.
    await frame.locator("#area_id").press("Control+Home");
    await page.screenshot({ path: "/tmp/sortsys-private-office-real.png" });
    const peerContext = await browser.newContext();
    auxiliaries.push(peerContext);
    observeEditorContext(peerContext);
    const peer = await peerContext.newPage();
    await peer.goto(server.url.href);
    observePage(peer, "Peer");
    await peer.waitForFunction(() => typeof window.startOffice === "function");
    await peer.evaluate(
      ({ bytes, origin, keys }) =>
        window.startOffice(bytes, origin, {
          accessKey: keys.editKey,
          viewKey: keys.viewKey,
        }),
      { bytes: Array.from(original), origin, keys: result.session },
    );
    await peer.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120000 },
    );
    assert.equal(await peer.evaluate(() => window.officeTest.errors), 0);
    const peerFrame = peer
      .frames()
      .find((frame) => frame.url().includes("/documenteditor/main/"));
    assert.ok(peerFrame);
    // Readiness is announced before the upstream history patch is applied.
    // Confirm that conversion already includes the first collaborator's edit
    // before sending keys into the newly loaded canvas.
    const caughtUp = await peer.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (await window.officeTest.bridge!.export("docx")).arrayBuffer(),
        ),
      ),
    );
    assert.ok(
      (await documentText(caughtUp)).includes(edit),
      "The peer must receive the shared history before editing",
    );
    await peer.bringToFront();
    await peerFrame.locator("#area_id").press("Control+End");
    await peerFrame.locator("#area_id").pressSequentially(peerEdit);
    let merged = false;
    const deadline = Date.now() + 45000;
    while (!merged && Date.now() < deadline) {
      const documents = (
        await Promise.all(
          [page, peer].map((editor) =>
            editor.evaluate(() => window.officeTest.saved),
          ),
        )
      ).flat();
      for (const bytes of documents) {
        const text = await documentText(bytes);
        if (
          text.includes(initial) &&
          text.includes(edit) &&
          text.includes(peerEdit)
        ) {
          merged = true;
          break;
        }
      }
      if (!merged) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!merged) {
      for (const [index, editor] of [page, peer].entries()) {
        const state = await editor.evaluate(() => ({
          errors: window.officeTest.errors,
          saved: window.officeTest.saved,
        }));
        console.error("Synthetic collaboration state", index, {
          errors: state.errors,
          saved: state.saved.length,
          documents: await Promise.all(state.saved.slice(-3).map(documentText)),
        });
      }
      await peer.screenshot({ path: "/tmp/sortsys-private-office-peer.png" });
    }
    assert.equal(
      merged,
      true,
      "Two independent browser contexts must preserve each other's edits in the same room",
    );
    console.log("Office proof: both collaborator edits merged");
    await assertPrivateBrowserState(peerContext, [
      result.session.editKey,
      result.session.viewKey,
    ]);
    await peerContext.close();
    const readerContext = await browser.newContext();
    auxiliaries.push(readerContext);
    observeEditorContext(readerContext);
    const reader = await readerContext.newPage();
    await reader.goto(server.url.href);
    observePage(reader, "Reader");
    await reader.waitForFunction(
      () => typeof window.startOffice === "function",
    );
    await reader.evaluate(
      ({ bytes, origin, key }) =>
        window.startOffice(bytes, origin, {
          canEdit: false,
          accessKey: key,
          viewKey: key,
        }),
      { bytes: Array.from(original), origin, key: result.session.viewKey },
    );
    await reader.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120000 },
    );
    assert.equal(await reader.evaluate(() => window.officeTest.errors), 0);
    const viewed = await reader.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (await window.officeTest.bridge!.export("docx")).arrayBuffer(),
        ),
      ),
    );
    const viewedText = await documentText(viewed);
    assert.ok(
      viewedText.includes(edit) && viewedText.includes(peerEdit),
      "A view capability must open the shared edited document, not just the supplied original",
    );
    assert.equal(
      await reader.evaluate(() => window.officeTest.saved.length),
      0,
    );
    assert.equal(await reader.evaluate(() => window.officeTest.session), null);
    console.log("Office proof: shared read-only DOCX export verified");
    const savedBeforeDraft = await page.evaluate(() => {
      window.officeTest.holdSaves = true;
      return window.officeTest.saved.length;
    });
    await page.bringToFront();
    await frame.locator("#area_id").press("Control+End");
    await frame.locator("#area_id").pressSequentially(unconfirmedDraft);
    async function exportedText(editor: import("playwright").Page) {
      return documentText(
        await editor.evaluate(async () =>
          Array.from(
            new Uint8Array(
              await (
                await window.officeTest.bridge!.export("docx")
              ).arrayBuffer(),
            ),
          ),
        ),
      );
    }
    async function waitForSharedText(text: string) {
      const deadline = Date.now() + 30000;
      while (!(await exportedText(reader)).includes(text)) {
        assert.ok(
          Date.now() < deadline,
          "The encrypted room must receive the edit",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await waitForSharedText(unconfirmedDraft);
    const recoveryContext = await browser.newContext();
    auxiliaries.push(recoveryContext);
    observeEditorContext(recoveryContext);
    const recoveryPage = await recoveryContext.newPage();
    observePage(recoveryPage, "Draft recovery");
    await recoveryPage.goto(server.url.href);
    await recoveryPage.waitForFunction(
      () => typeof window.recoverOfficeDraft === "function",
    );
    const recoveredDraft = await recoveryPage.evaluate(
      ({ bytes, origin, key }) => window.recoverOfficeDraft(bytes, origin, key),
      { bytes: Array.from(original), origin, key: result.session.viewKey },
    );
    const recoveredText = await documentText(recoveredDraft);
    assert.ok(
      recoveredText.includes(initial) &&
        recoveredText.includes(edit) &&
        recoveredText.includes(peerEdit) &&
        recoveredText.includes(unconfirmedDraft),
    );
    assert.equal(
      await page.evaluate(() => window.officeTest.saved.length),
      savedBeforeDraft,
      "Recovery must read the shared draft even though no newer file was confirmed",
    );
    const replacementContext = await browser.newContext();
    auxiliaries.push(replacementContext);
    observeEditorContext(replacementContext);
    const replacement = await replacementContext.newPage();
    observePage(replacement, "Replacement room");
    await replacement.goto(server.url.href);
    await replacement.waitForFunction(
      () => typeof window.startOffice === "function",
    );
    await replacement.evaluate(
      ({ bytes, origin }) => window.startOffice(bytes, origin),
      { bytes: recoveredDraft, origin },
    );
    await replacement.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120000 },
    );
    assert.equal(await replacement.evaluate(() => window.officeTest.errors), 0);
    const replacementRoom = await replacement.evaluate(
      () => window.officeTest.session!,
    );
    assert.notEqual(replacementRoom.editKey, result.session.editKey);
    assert.notEqual(replacementRoom.viewKey, result.session.viewKey);
    assert.ok((await exportedText(replacement)).includes(unconfirmedDraft));
    await page.bringToFront();
    await frame.locator("#area_id").pressSequentially(oldRoomEdit);
    await waitForSharedText(oldRoomEdit);
    assert.ok(
      !(await exportedText(replacement)).includes(oldRoomEdit),
      "Later writes through the revoked old capability must not enter the replacement room",
    );
    await assertPrivateBrowserState(replacementContext, [
      replacementRoom.editKey,
      replacementRoom.viewKey,
    ]);
    await assertPrivateBrowserState(recoveryContext, [
      result.session.viewKey,
    ]);
    await assertPrivateBrowserState(readerContext, [result.session.viewKey]);
    await assertPrivateBrowserState(context, [
      result.session.editKey,
      result.session.viewKey,
    ]);
    await replacementContext.close();
    await recoveryContext.close();
    console.log(
      "Office proof: unconfirmed shared draft transferred through a view capability into a fresh room; later old-room edits stay excluded",
    );
    await readerContext.close();
    await page.evaluate(() => window.officeTest.bridge!.close());
    await page.waitForFunction(
      () => document.querySelector<HTMLIFrameElement>("#editor")?.src === "about:blank",
    );
    await assertPrivateBrowserState(context, [
      result.session.editKey,
      result.session.viewKey,
    ]);
    await context.close();
    const container = process.env.SORTSYS_OFFICE_TEST_CONTAINER;
    if (container) {
      const runtime = process.env.SORTSYS_OFFICE_TEST_RUNTIME;
      assert.match(container, /^sortsys-test-private-office-[0-9]+-[0-9]+$/);
      assert.ok(runtime === "docker" || runtime === "podman");
      assert.equal(spawnSync([runtime, "restart", container]).exitCode, 0);
      let healthy = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        const status = spawnSync([
          runtime,
          "inspect",
          "-f",
          "{{.State.Health.Status}}",
          container,
        ]);
        if (
          status.exitCode === 0 &&
          status.stdout.toString().trim() === "healthy"
        ) {
          healthy = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(
        healthy,
        true,
        "The disposable Office service must recover after restart",
      );
      const resumedContext = await browser.newContext();
      auxiliaries.push(resumedContext);
      observeEditorContext(resumedContext);
      const resumed = await resumedContext.newPage();
      observePage(resumed, "Reconnected reader");
      await resumed.goto(server.url.href);
      await resumed.waitForFunction(
        () => typeof window.startOffice === "function",
      );
      await resumed.evaluate(
        ({ bytes, origin, key }) =>
          window.startOffice(bytes, origin, {
            canEdit: false,
            accessKey: key,
            viewKey: key,
          }),
        { bytes: Array.from(original), origin, key: result.session.viewKey },
      );
      await resumed.waitForFunction(
        () => window.officeTest.ready || window.officeTest.errors > 0,
        undefined,
        { timeout: 120000 },
      );
      assert.equal(await resumed.evaluate(() => window.officeTest.errors), 0);
      const restored = await resumed.evaluate(async () =>
        Array.from(
          new Uint8Array(
            await (
              await window.officeTest.bridge!.export("docx")
            ).arrayBuffer(),
          ),
        ),
      );
      const restoredText = await documentText(restored);
      assert.ok(
        restoredText.includes(initial) &&
          restoredText.includes(edit) &&
          restoredText.includes(peerEdit),
        "Room ciphertext must survive closing every client and restarting the service",
      );
      await resumedContext.close();
      console.log(
        "Office proof: shared room restored after every client closed and the service restarted",
      );
    }
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Mengen");
    sheet.getCell("A1").value = "MENGEN_PRIVATE_OFFICE";
    sheet.getCell("A1").font = { bold: true };
    sheet.getCell("B2").value = 5.375;
    sheet.getCell("C2").value = 2.834;
    sheet.getCell("D2").value = { formula: "B2*C2", result: 15.23275 };
    sheet.getCell("D2").numFmt = '0.000" m²"';
    sheet.getCell("E3").value = 592;
    sheet.getCell("E3").numFmt = '#,##0.00" €"';
    sheet.headerFooter.oddHeader = "&CProjektübersicht";
    const image = workbook.addImage({
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNwKDiAFTEMLQkA0tVcAZtsCF8AAAAASUVORK5CYII=",
      extension: "png",
    });
    sheet.addImage(image, "A5:B7");
    workbook.addWorksheet("Übersicht").getCell("A1").value = {
      formula: "Mengen!D2",
      result: 15.23275,
    };
    const spreadsheet = Array.from(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
    );
    const sheetSettings: EditorSettings = {
      fileName: "Mengen.xlsx",
      application: "sheet",
    };
    const sheetPage = await openOfficeFile(
      spreadsheet,
      sheetSettings,
      "Spreadsheet editor",
    );
    console.log("Office proof: spreadsheet editor ready");
    async function readWorkbook(bytes: number[]) {
      const exportedWorkbook = new ExcelJS.Workbook();
      await exportedWorkbook.xlsx.load(new Uint8Array(bytes).buffer);
      return exportedWorkbook;
    }
    const converted = await readWorkbook(
      await exportOfficeFile(sheetPage, "xlsx"),
    );
    const convertedSheet = converted.getWorksheet("Mengen");
    assert.ok(convertedSheet);
    assert.equal(convertedSheet.getCell("A1").value, "MENGEN_PRIVATE_OFFICE");
    assert.equal(convertedSheet.getCell("A1").font.bold, true);
    assert.equal(convertedSheet.getCell("D2").formula, "B2*C2");
    assert.ok(
      Math.abs(Number(convertedSheet.getCell("D2").result) - 15.23275) < 1e-9,
    );
    assert.ok(convertedSheet.getCell("D2").numFmt.includes("m²"));
    assert.ok(convertedSheet.getCell("E3").numFmt.includes("€"));
    assert.ok(
      convertedSheet.headerFooter.oddHeader?.includes("Projektübersicht"),
    );
    assert.equal(convertedSheet.getImages().length, 1);
    console.log(
      "Office proof: spreadsheet formula, style, header and image round-trip verified",
    );
    const pdf = await exportOfficeFile(sheetPage, "pdf");
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");

    await nextAutosave(sheetPage, 0);
    const sheetSaveCount = await sheetPage.evaluate(
      () => window.officeTest.saved.length,
    );
    const sheetFrame = sheetPage.frame({ url: /\/spreadsheeteditor\/main\// });
    assert.ok(sheetFrame);
    const selectedCell = sheetFrame.locator("#ce-cell-name");
    await selectedCell.fill("B2");
    await selectedCell.press("Enter");
    const cellValue = sheetFrame.locator("#ce-cell-content");
    assert.equal(await cellValue.inputValue(), "5.375");
    await cellValue.selectText();
    await cellValue.pressSequentially("6");
    await cellValue.press("Enter");

    function assertRecalculated(workbook: ExcelJS.Workbook) {
      const quantities = workbook.getWorksheet("Mengen");
      const overview = workbook.getWorksheet("Übersicht");
      assert.ok(quantities && overview);
      const product = quantities.getCell("D2");
      const total = overview.getCell("A1");
      assert.equal(quantities.getCell("B2").value, 6);
      assert.equal(product.formula, "B2*C2");
      assert.match(total.formula ?? "", /^(?:Mengen|'Mengen')!D2$/);
      for (const cell of [product, total]) {
        assert.ok(Math.abs(Number(cell.result) - 17.004) < 1e-9);
      }
    }
    assertRecalculated(
      await readWorkbook(await nextAutosave(sheetPage, sheetSaveCount)),
    );
    const sheetRoom = await sheetPage.evaluate(() => window.officeTest.session);
    assert.ok(sheetRoom);
    const sheetReader = await openOfficeFile(
      spreadsheet,
      { ...sheetSettings, canEdit: false, accessKey: sheetRoom.viewKey },
      "Spreadsheet reader",
    );
    assertRecalculated(
      await readWorkbook(await exportOfficeFile(sheetReader, "xlsx")),
    );
    assert.equal(
      await sheetReader.evaluate(() => window.officeTest.saved.length),
      0,
    );
    console.log(
      "Office proof: XLSX keyboard autosave and cross-sheet totals seen by a reader",
    );

    const blankPresentation = await createBlankProjectFile(
      "pptx",
      presentationName,
    );
    const presentation = Array.from(
      new Uint8Array(await blankPresentation.arrayBuffer()),
    );
    const slideSettings: EditorSettings = {
      fileName: presentationName,
      application: "presentation",
    };
    const slidePage = await openOfficeFile(
      presentation,
      slideSettings,
      "Presentation editor",
    );
    await nextAutosave(slidePage, 0);
    const slideSaveCount = await slidePage.evaluate(
      () => window.officeTest.saved.length,
    );
    const slideFrame = slidePage.frame({ url: /\/presentationeditor\/main\// });
    assert.ok(slideFrame);
    const intro = slideFrame.getByText("Got it", { exact: true });
    if (await intro.isVisible()) await intro.click();
    await slideFrame
      .locator('[id^="tlbtn-inserttext-"]:visible .inner-box-icon')
      .click();
    const slide = await slideFrame.locator("#id_viewer").boundingBox();
    assert.ok(slide);
    await slidePage.mouse.move(
      slide.x + slide.width * 0.27,
      slide.y + slide.height * 0.32,
    );
    await slidePage.mouse.down();
    await slidePage.mouse.move(
      slide.x + slide.width * 0.72,
      slide.y + slide.height * 0.5,
      { steps: 8 },
    );
    await slidePage.mouse.up();
    await slidePage.keyboard.type(presentationText);
    await slidePage.keyboard.press("Escape");

    async function assertPresentation(bytes: number[]) {
      const archive = await JSZip.loadAsync(Buffer.from(bytes));
      const metadata = await archive.file("ppt/presentation.xml")!.async("string");
      const slide = await archive.file("ppt/slides/slide1.xml")!.async("string");
      assert.match(
        metadata,
        /<p:sldSz\b[^>]*\bcx="12192000"[^>]*\bcy="6858000"/,
      );
      assert.ok(slide.includes(`<a:t>${presentationText}</a:t>`));
    }
    await assertPresentation(await nextAutosave(slidePage, slideSaveCount));
    const presentationRoom = await slidePage.evaluate(
      () => window.officeTest.session,
    );
    assert.ok(presentationRoom);
    const slideReader = await openOfficeFile(
      presentation,
      { ...slideSettings, canEdit: false, accessKey: presentationRoom.viewKey },
      "Presentation reader",
    );
    await assertPresentation(await exportOfficeFile(slideReader, "pptx"));
    assert.equal(
      await slideReader.evaluate(() => window.officeTest.saved.length),
      0,
    );
    console.log(
      "Office proof: PPTX text box and slide dimensions preserved in autosave and read-only room",
    );

    const detail = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      ${diagramImageCell("detail-image", detailImage)}</root></mxGraphModel>`;
    const compressedDetail = deflateRawSync(encodeURIComponent(detail)).toString(
      "base64",
    );
    const diagram = new TextEncoder().encode(`<mxfile>
      <diagram id="construction" name="Bauablauf"><mxGraphModel><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="a" value="${diagramInitialA}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="80" y="80" width="220" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="b" value="${diagramInitialB}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1">
          <mxGeometry x="360" y="80" width="220" height="80" as="geometry"/>
        </mxCell>
        ${diagramImageCell("plan-image", planImage)}
      </root></mxGraphModel></diagram>
      <diagram id="detail" name="${diagramDetailPage}">${compressedDetail}</diagram>
    </mxfile>`);
    async function openSharedDiagram(canEdit: boolean, key?: string) {
      const diagramContext = await browser!.newContext();
      auxiliaries.push(diagramContext);
      observeEditorContext(diagramContext);
      const imageUploads = new Set<string>();
      diagramContext.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith("/upload-blob/")) imageUploads.add(pathname);
      });
      const diagramPage = await diagramContext.newPage();
      observePage(diagramPage, "Diagram");
      await diagramPage.goto(server.url.href);
      await diagramPage.waitForFunction(
        () => typeof window.startOffice === "function",
      );
      await diagramPage.evaluate(
        ({ bytes, origin, canEdit, key, fileName }) => {
          window.officeTest.holdSaves = true;
          window.startOffice(bytes, origin, {
            fileName,
            application: "diagram",
            canEdit,
            accessKey: key,
            viewKey: canEdit ? undefined : key,
          });
        },
        {
          bytes: Array.from(diagram),
          origin,
          canEdit,
          key,
          fileName: diagramFileName,
        },
      );
      await diagramPage.waitForFunction(
        () => window.officeTest.ready || window.officeTest.errors > 0,
        undefined,
        { timeout: 120000 },
      );
      assert.equal(
        await diagramPage.evaluate(() => window.officeTest.errors),
        0,
      );
      const isDrawingFrame = (frame: Frame) =>
        new URL(frame.url()).pathname ===
        "/components/drawio/src/main/webapp/index.html";
      const drawing =
        diagramPage.frames().find(isDrawingFrame) ??
        (await diagramPage.waitForEvent("framenavigated", {
          predicate: isDrawingFrame,
          timeout: 120000,
        }));
      await drawing.locator(".geDiagramContainer").waitFor({ timeout: 120000 });
      return {
        context: diagramContext,
        page: diagramPage,
        drawing,
        imageUploads,
      };
    }
    async function editDiagramLabel(
      frame: Frame,
      previous: string,
      next: string,
    ) {
      await frame
        .locator(".geDiagramContainer")
        .getByText(previous, { exact: true })
        .dblclick();
      const input = frame.locator(".mxCellEditor[contenteditable=true]");
      await input.fill(next);
      await input.press("Control+Enter");
      await input.waitFor({ state: "hidden" });
    }
    const firstDiagram = await openSharedDiagram(true);
    await firstDiagram.drawing
      .locator(".geDiagramContainer")
      .getByText(diagramInitialA, { exact: true })
      .waitFor();
    assert.equal(
      firstDiagram.imageUploads.size,
      2,
      "The fresh room should encrypt and upload the image from each page",
    );
    const diagramSession = await firstDiagram.page.evaluate(
      () => window.officeTest.session,
    );
    assert.ok(diagramSession);
    const secondDiagram = await openSharedDiagram(true, diagramSession.editKey);
    await Promise.all([
      editDiagramLabel(firstDiagram.drawing, diagramInitialA, diagramEditA),
      editDiagramLabel(secondDiagram.drawing, diagramInitialB, diagramEditB),
    ]);
    for (const editor of [firstDiagram, secondDiagram]) {
      await editor.drawing
        .locator(".geDiagramContainer")
        .getByText(diagramEditA, { exact: true })
        .waitFor();
      await editor.drawing
        .locator(".geDiagramContainer")
        .getByText(diagramEditB, { exact: true })
        .waitFor();
      await checkSharedDiagram(
        editor.page,
        await waitForSharedDiagramExport(editor.page),
      );
      await waitForDiagramImage(editor.drawing, planImage);
      await editor.drawing
        .locator(".gePageTab")
        .getByText(diagramDetailPage, { exact: true })
        .click();
      await waitForDiagramImage(editor.drawing, detailImage);
      assert.equal(
        await editor.page.evaluate(() => window.officeTest.saved.length),
        0,
      );
      await assertPrivateBrowserState(editor.context, [
        diagramSession.editKey,
        diagramSession.viewKey,
      ]);
    }
    await firstDiagram.page.screenshot({
      path: "/tmp/sortsys-private-diagram.png",
    });
    await firstDiagram.context.close();
    await secondDiagram.context.close();
    const readOnlyDiagram = await openSharedDiagram(
      false,
      diagramSession.viewKey,
    );
    await checkSharedDiagram(
      readOnlyDiagram.page,
      await waitForSharedDiagramExport(readOnlyDiagram.page),
    );
    assert.equal(readOnlyDiagram.imageUploads.size, 0);
    assert.equal(
      await readOnlyDiagram.page.evaluate(() => window.officeTest.session),
      null,
    );
    assert.equal(
      await readOnlyDiagram.page.evaluate(() => window.officeTest.saved.length),
      0,
    );
    await assertPrivateBrowserState(readOnlyDiagram.context, [
      diagramSession.viewKey,
    ]);
    await readOnlyDiagram.context.close();
    const diagramRecoveryContext = await browser.newContext();
    auxiliaries.push(diagramRecoveryContext);
    observeEditorContext(diagramRecoveryContext);
    const diagramRecoveryPage = await diagramRecoveryContext.newPage();
    await diagramRecoveryPage.goto(server.url.href);
    await diagramRecoveryPage.waitForFunction(
      () => typeof window.recoverOfficeDraft === "function",
    );
    const recoveredDiagram = await diagramRecoveryPage.evaluate(
      ({ bytes, origin, viewKey, fileName }) =>
        window.recoverOfficeDraft(bytes, origin, viewKey, {
          fileName,
          application: "diagram",
        }),
      {
        bytes: Array.from(diagram),
        origin,
        viewKey: diagramSession.viewKey,
        fileName: diagramFileName,
      },
    );
    const recoveredDiagramXml = new TextDecoder().decode(
      new Uint8Array(recoveredDiagram),
    );
    await checkSharedDiagram(diagramRecoveryPage, recoveredDiagramXml);
    await assertPrivateBrowserState(diagramRecoveryContext, [
      diagramSession.viewKey,
    ]);
    await diagramRecoveryContext.close();
    console.log(
      "Diagram proof: independent edits and both embedded images survive native export, view-only reopening and draft recovery",
    );
    assert.ok(
      uploads > 0,
      "The real encrypted-block upload route must be exercised",
    );
    for (const route of [
      "/ooapidl?url=https://invalid.example/",
      "/oosave",
      "/ConvertService.ashx",
      "/proxy",
    ]) {
      assert.equal(
        (await fetch(origin + route)).status,
        403,
        "Plaintext server routes must be blocked",
      );
    }
    const policy = (await fetch(origin + "/integration/")).headers.get(
      "content-security-policy",
    )!;
    assert.ok(policy.includes(`frame-ancestors ${server.url.origin} `));
    assert.ok(policy.includes("default-src 'none'"));
    assert.ok(!policy.includes("'unsafe-eval'"));
    for (const [path, permitsEval] of [
      ["/diagram/inner.html", false],
      ["/sheet/inner.html", true],
    ] as const) {
      const response: Response = await fetch(origin + path);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers
          .get("content-security-policy")!
          .includes("'unsafe-eval'"),
        permitsEval,
      );
    }
    assert.deepEqual(forbidden, []);
    assert.deepEqual(leaks, []);
    for (const marker of [planImage, detailImage]) {
      const plaintext = Buffer.from(marker, "base64");
      assert.ok(
        sentBodies.every((body) => !body.includes(plaintext)) &&
          sentFrames.every((frame) => !frame.includes(plaintext)),
        "An unencrypted diagram image appeared in network traffic",
      );
    }
    assert.ok(
      workerFrameCount > 0,
      "The privacy check must observe real outbound worker collaboration traffic",
    );
    assert.deepEqual(workerTraffic.errors, []);
    assert.equal(
      captureOverflow,
      false,
      "The test must inspect every outbound payload within its capture budget",
    );
    await assertPrivateBrowserState(sheetPage.context(), [
      sheetRoom.editKey,
      sheetRoom.viewKey,
    ]);
    await assertPrivateBrowserState(sheetReader.context(), [sheetRoom.viewKey]);
    await assertPrivateBrowserState(slidePage.context(), [
      presentationRoom.editKey,
      presentationRoom.viewKey,
    ]);
    await assertPrivateBrowserState(slideReader.context(), [
      presentationRoom.viewKey,
    ]);
    for (const key of [
      result.session.editKey,
      result.session.viewKey,
      replacementRoom.editKey,
      replacementRoom.viewKey,
      diagramSession.editKey,
      diagramSession.viewKey,
      sheetRoom.editKey,
      sheetRoom.viewKey,
      presentationRoom.editKey,
      presentationRoom.viewKey,
    ]) {
      for (const secret of [key, key.split("/").filter(Boolean).at(-1)!]) {
        assert.ok(
          sentUrls.every(
            (url) =>
              !url.includes(secret) &&
              !url.includes(encodeURIComponent(secret)),
          ),
          "An editor capability appeared in a network URL",
        );
        assert.ok(
          sentBodies.every((body) => !containsText(body, secret)),
          "An editor capability appeared in an outbound HTTP body",
        );
        assert.ok(
          sentFrames.every((frame) => !containsText(frame, secret)),
          "An editor capability appeared in an outbound WebSocket frame",
        );
      }
    }
    console.log(
      "Real private editors verified: DOCX and Drawio collaboration, XLSX and PPTX keyboard autosave and read-only rooms, cross-sheet calculations, diagram draft recovery, local PDF conversion and protected traffic.",
    );
    console.log(
      `Inspected ${sentFrames.length} outbound WebSocket frames (${sentFrameBytes} bytes)`,
    );
  } catch (error) {
    console.error("Disposable Office diagnostics:", diagnostics.slice(-20));
    console.error(
      "Disposable Office frames:",
      [context, ...auxiliaries]
        .flatMap((context) => context.pages())
        .flatMap((page) => page.frames())
        .map((frame) => {
          const url = new URL(frame.url());
          return url.origin + url.pathname;
        }),
    );
    const currentPage = [context, ...auxiliaries]
      .flatMap((context) => context.pages())
      .at(-1);
    await currentPage
      ?.screenshot({ path: "/tmp/sortsys-private-editor-failed.png" })
      .catch(() => {});
    throw error;
  } finally {
    for (const auxiliary of auxiliaries) await auxiliary.close();
    await context.close();
  }
} finally {
  await workerTraffic?.close();
  await browser?.close();
  await server.stop(true);
}

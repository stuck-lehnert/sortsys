/** Opt-in integration against an owned, disposable CryptPad installation. */
import assert from "node:assert/strict";
import { build, serve, spawnSync } from "bun";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import { chromium, type BrowserContext, type Request } from "playwright";
import { observeWorkerTraffic } from "./lib/workerTraffic";

if (process.env.SORTSYS_DISPOSABLE_OFFICE_TEST !== "1")
  throw new Error("A disposable Office test installation is required");
const origin = process.env.SORTSYS_OFFICE_TEST_ORIGIN ?? "";
if (!origin || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/.test(origin)) {
  throw new Error("An explicit loopback Office test origin is required");
}
const bundle = await build({
  entrypoints: [
    new URL("../app/lib/cryptpadBridge.ts", import.meta.url).pathname,
    new URL("../app/lib/officeDraft.ts", import.meta.url).pathname,
  ],
  target: "browser",
  format: "esm",
});
assert.equal(bundle.success, true);
const javascript = await bundle.outputs
  .find((output) => output.path.endsWith("cryptpadBridge.js"))!
  .text();
const draftJavascript = await bundle.outputs
  .find((output) => output.path.endsWith("officeDraft.js"))!
  .text();
const initial = "SORTSYS_PRIVATE_OFFICE_TEST_20261109";
const edit = "_EDITED_IN_BROWSER";
const peerEdit = "_SECOND_COLLABORATOR";
const unconfirmedDraft = "_UNCONFIRMED_DRAFT_FOR_REKEY";
const oldRoomEdit = "_OLD_ROOM_AFTER_REKEY";
const diagramInitialA = "SORTSYS_PRIVATE_DIAGRAM_A";
const diagramInitialB = "SORTSYS_PRIVATE_DIAGRAM_B";
const diagramEditA = "SORTSYS_PRIVATE_DIAGRAM_EDIT_A";
const diagramEditB = "SORTSYS_PRIVATE_DIAGRAM_EDIT_B";
const diagramFileName = "Privater-Bauablauf.drawio";
const privateMarkers = [
  initial,
  edit,
  peerEdit,
  unconfirmedDraft,
  oldRoomEdit,
  "Proof.docx",
  "MENGEN_PRIVATE_OFFICE",
  "Mengen.xlsx",
  diagramInitialA,
  diagramInitialB,
  diagramEditA,
  diagramEditB,
  diagramFileName,
];
const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
);
zip.file(
  "_rels/.rels",
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
);
zip.file(
  "word/document.xml",
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${initial}</w:t></w:r></w:p><w:p><w:r><w:t>Zusammenarbeit</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
);
const original = await zip.generateAsync({
  type: "uint8array",
  compression: "STORE",
});
const html = `<!doctype html>
<html><body style="margin:0">
<iframe id="editor" style="width:100vw;height:100vh;border:0"></iframe>
<script type="module">
import { openCryptPad } from '/bridge.js';
import { readOfficeDraft } from '/draft.js';
window.officeTest = {
  ready: false, errors: 0, saved: [], session: null, holdSaves: false, pending: [],
};
window.recoverOfficeDraft = async (bytes, origin, viewKey, settings = {}) => {
  const recovered = await readOfficeDraft({
    iframe: document.getElementById('editor'),
    editorOrigin: origin,
    document: new Blob([new Uint8Array(bytes)]),
    fileName: settings.fileName || 'Proof.docx',
    application: settings.application || 'doc',
    locale: 'de',
    viewKey,
    signal: new AbortController().signal,
  });
  return Array.from(new Uint8Array(await recovered.arrayBuffer()));
};
window.startOffice = (bytes, origin, settings = {}) => {
  window.officeTest.bridge = openCryptPad({
    iframe: document.getElementById('editor'),
    editorOrigin: origin,
    document: new Blob([new Uint8Array(bytes)]),
    fileName: settings.fileName || 'Proof.docx',
    application: settings.application || 'doc',
    locale: 'de',
    canEdit: settings.canEdit !== false,
    accessKey: settings.accessKey,
    viewKey: settings.viewKey,
    publishSession: async (previous, session) => {
      window.officeTest.session = session;
      return session;
    },
    save: async blob => {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      if (window.officeTest.holdSaves) {
        window.officeTest.pending.push(bytes);
        return new Promise(() => {});
      }
      window.officeTest.saved.push(bytes);
    },
    onReady: () => { window.officeTest.ready = true; },
    onError: () => { window.officeTest.errors++; },
  });
};
</script></body></html>`;
const server = serve({
  hostname: "127.0.0.1",
  port: Number(process.env.SORTSYS_OFFICE_APP_PORT ?? 0),
  fetch(request) {
    const path = new URL(request.url).pathname;
    const script = path === "/bridge.js" || path === "/draft.js";
    let content = html;
    if (path === "/bridge.js") content = javascript;
    else if (path === "/draft.js") content = draftJavascript;
    return new Response(content, {
      headers: {
        "content-type": script ? "application/javascript" : "text/html",
      },
    });
  },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workerTraffic: Awaited<ReturnType<typeof observeWorkerTraffic>> | undefined;
try {
  browser = await chromium.launch({
    args: ["--remote-debugging-port=0", "--enable-automation"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const diagnostics: string[] = [];
  const observePage = (page: import("playwright").Page, label: string) => {
    page.on("pageerror", (error) =>
      diagnostics.push(`${label}: ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.push(`${label}: ${message.text().slice(0, 500)}`);
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
    const observeSockets = (page: import("playwright").Page) => {
      page.on("websocket", (socket) => {
        sentUrls.push(socket.url());
        socket.on("framesent", ({ payload }) => {
          const bytes =
            typeof payload === "string" ? Buffer.from(payload) : payload;
          observeFrame(bytes);
        });
      });
    };
    context.on("page", observeSockets);
    for (const page of context.pages()) {
      observeSockets(page);
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
  const documentText = async (bytes: number[]) => {
    const saved = await JSZip.loadAsync(new Uint8Array(bytes));
    return (await saved.file("word/document.xml")!.async("string")).replace(
      /<[^>]*>/g,
      "",
    );
  };
  async function assertPrivateBrowserStorage(
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
    await assertPrivateBrowserStorage(peerContext, [
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
    await assertPrivateBrowserStorage(replacementContext, [
      replacementRoom.editKey,
      replacementRoom.viewKey,
    ]);
    await assertPrivateBrowserStorage(recoveryContext, [
      result.session.viewKey,
    ]);
    await assertPrivateBrowserStorage(readerContext, [result.session.viewKey]);
    await assertPrivateBrowserStorage(context, [
      result.session.editKey,
      result.session.viewKey,
    ]);
    await replacementContext.close();
    await recoveryContext.close();
    console.log(
      "Office proof: unconfirmed shared draft transferred through a view capability into a fresh room; later old-room edits stay excluded",
    );
    await readerContext.close();
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
    const spreadsheet = Array.from(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
    );
    const sheetContext = await browser.newContext();
    auxiliaries.push(sheetContext);
    observeEditorContext(sheetContext);
    const sheetPage = await sheetContext.newPage();
    await sheetPage.goto(server.url.href);
    observePage(sheetPage, "Sheet");
    await sheetPage.waitForFunction(
      () => typeof window.startOffice === "function",
    );
    await sheetPage.evaluate(
      ({ bytes, origin }) =>
        window.startOffice(bytes, origin, {
          fileName: "Mengen.xlsx",
          application: "sheet",
        }),
      { bytes: spreadsheet, origin },
    );
    await sheetPage.waitForFunction(
      () => window.officeTest.ready || window.officeTest.errors > 0,
      undefined,
      { timeout: 120000 },
    );
    assert.equal(await sheetPage.evaluate(() => window.officeTest.errors), 0);
    console.log("Office proof: spreadsheet editor ready");
    const exportedSheet = await sheetPage.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (await window.officeTest.bridge!.export("xlsx")).arrayBuffer(),
        ),
      ),
    );
    const converted = new ExcelJS.Workbook();
    await converted.xlsx.load(
      new Uint8Array(exportedSheet) as unknown as Parameters<
        typeof converted.xlsx.load
      >[0],
    );
    const convertedSheet = converted.getWorksheet("Mengen")!;
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
    const pdf = await sheetPage.evaluate(async () =>
      Array.from(
        new Uint8Array(
          await (await window.officeTest.bridge!.export("pdf")).arrayBuffer(),
        ),
      ),
    );
    assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
    const diagram = new TextEncoder().encode(
      `<mxfile><diagram id="construction" name="Bauablauf"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${diagramInitialA}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="80" y="80" width="220" height="80" as="geometry"/></mxCell><mxCell id="b" value="${diagramInitialB}" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="360" y="80" width="220" height="80" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`,
    );
    async function openSharedDiagram(canEdit: boolean, key?: string) {
      const diagramContext = await browser!.newContext();
      auxiliaries.push(diagramContext);
      observeEditorContext(diagramContext);
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
      const isDrawingFrame = (frame: import("playwright").Frame) =>
        new URL(frame.url()).pathname ===
        "/components/drawio/src/main/webapp/index.html";
      const drawing =
        diagramPage.frames().find(isDrawingFrame) ??
        (await diagramPage.waitForEvent("framenavigated", {
          predicate: isDrawingFrame,
          timeout: 120000,
        }));
      await drawing.locator(".geDiagramContainer").waitFor({ timeout: 120000 });
      return { context: diagramContext, page: diagramPage, drawing };
    }
    async function editDiagramLabel(
      frame: import("playwright").Frame,
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
      const exported = await editor.page.evaluate(async () =>
        (await window.officeTest.bridge!.export("drawio")).text(),
      );
      assert.ok(
        exported.includes(diagramEditA) && exported.includes(diagramEditB),
      );
      assert.equal(
        await editor.page.evaluate(() => window.officeTest.saved.length),
        0,
      );
      await assertPrivateBrowserStorage(editor.context, [
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
    const viewedDiagram = await readOnlyDiagram.page.evaluate(async () =>
      (await window.officeTest.bridge!.export("drawio")).text(),
    );
    assert.ok(
      viewedDiagram.includes(diagramEditA) &&
        viewedDiagram.includes(diagramEditB),
    );
    assert.equal(
      await readOnlyDiagram.page.evaluate(() => window.officeTest.session),
      null,
    );
    assert.equal(
      await readOnlyDiagram.page.evaluate(() => window.officeTest.saved.length),
      0,
    );
    await assertPrivateBrowserStorage(readOnlyDiagram.context, [
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
    assert.ok(
      recoveredDiagramXml.includes(diagramEditA) &&
        recoveredDiagramXml.includes(diagramEditB),
      "Draft recovery must retain shared edits even when no project-file save was confirmed",
    );
    await assertPrivateBrowserStorage(diagramRecoveryContext, [
      diagramSession.viewKey,
    ]);
    await diagramRecoveryContext.close();
    console.log(
      "Diagram proof: independent edits merged, native XML exported, view-only reopening and unconfirmed draft recovery verified",
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
    await assertPrivateBrowserStorage(sheetContext);
    for (const key of [
      result.session.editKey,
      result.session.viewKey,
      replacementRoom.editKey,
      replacementRoom.viewKey,
      diagramSession.editKey,
      diagramSession.viewKey,
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
      "Real private editors verified: DOCX and Drawio collaboration, native diagram draft recovery, read-only shared export, XLSX formulas/formats/header/image, local PDF conversion, encrypted-block uploads and blocked plaintext server routes.",
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

declare global {
  interface Window {
    startOffice: (
      bytes: number[],
      origin: string,
      settings?: {
        canEdit?: boolean;
        accessKey?: string;
        viewKey?: string;
        fileName?: string;
        application?: "doc" | "sheet" | "presentation" | "diagram";
      },
    ) => void;
    recoverOfficeDraft: (
      bytes: number[],
      origin: string,
      viewKey: string,
      settings?: {
        fileName?: string;
        application?: "doc" | "sheet" | "presentation" | "diagram";
      },
    ) => Promise<number[]>;
    officeTest: {
      ready: boolean;
      errors: number;
      saved: number[][];
      holdSaves: boolean;
      pending: number[][];
      session: { editKey: string; viewKey: string } | null;
      bridge?: ReturnType<
        (typeof import("../app/lib/cryptpadBridge"))["openCryptPad"]
      >;
    };
  }
}

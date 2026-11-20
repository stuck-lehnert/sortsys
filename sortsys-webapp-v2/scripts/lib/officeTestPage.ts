import assert from "node:assert/strict";
import { build, serve } from "bun";
import JSZip from "jszip";
import type { Frame, Page } from "playwright";
import type {
  OfficeApplication,
  OfficeSession,
} from "../../app/lib/cryptpadBridge";

export async function officeTestDocument(text: string) {
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
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:p><w:r><w:t>Zusammenarbeit</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  const bytes = await zip.generateAsync({
    type: "arraybuffer",
    compression: "STORE",
  });
  return new Uint8Array(bytes);
}

export function officeTestDiagram(label: string) {
  return new TextEncoder().encode(
    `<mxfile><diagram id="schedule" name="Bauablauf"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="note" value="${label}" vertex="1" parent="1">
        <mxGeometry x="80" y="80" width="340" height="80" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`,
  );
}

export async function diagramEditor(page: Page) {
  const isDrawing = (frame: Frame) =>
    new URL(frame.url()).pathname === "/components/drawio/src/main/webapp/index.html";
  return page.frames().find(isDrawing) ?? page.waitForEvent("framenavigated", {
    predicate: isDrawing,
    timeout: 60_000,
  });
}

export async function changeDiagramLabel(frame: Frame, label: string, value: string) {
  await frame.locator(".geDiagramContainer").getByText(label, { exact: true }).dblclick();
  const input = frame.locator(".mxCellEditor[contenteditable=true]");
  await input.fill(value);
  await input.press("Control+Enter");
  await input.waitFor({ state: "hidden" });
}

export async function insertSlideText(frame: Frame, text: string) {
  const page = frame.page();
  const intro = frame.getByText(/^(Got it|Verstanden)$/);
  if (await intro.isVisible()) await intro.click();

  await frame
    .locator('[id^="tlbtn-inserttext-"]:visible .inner-box-icon')
    .click();
  const slide = await frame.locator("#id_viewer").boundingBox();
  assert.ok(slide);
  await page.mouse.move(
    slide.x + slide.width * 0.27,
    slide.y + slide.height * 0.32,
  );
  await page.mouse.down();
  await page.mouse.move(
    slide.x + slide.width * 0.72,
    slide.y + slide.height * 0.5,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

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
      const confirmed = window.publishOfficeRoom
        ? await window.publishOfficeRoom(previous ?? null, session)
        : session;
      window.officeTest.session = confirmed;
      return confirmed;
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
export async function serveOfficeTestPage(port: number) {
  const bundle = await build({
    entrypoints: [
      new URL("../../app/lib/cryptpadBridge.ts", import.meta.url).pathname,
      new URL("../../app/lib/officeDraft.ts", import.meta.url).pathname,
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
  return serve({
    hostname: "127.0.0.1",
    port: port,
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
}

declare global {
  interface Window {
    publishOfficeRoom?: (
      previous: string | null,
      proposed: OfficeSession,
    ) => Promise<OfficeSession>;
    startOffice: (
      bytes: number[],
      origin: string,
      settings?: {
        canEdit?: boolean;
        accessKey?: string;
        viewKey?: string;
        fileName?: string;
        application?: OfficeApplication;
      },
    ) => void;
    recoverOfficeDraft: (
      bytes: number[],
      origin: string,
      viewKey: string,
      settings?: {
        fileName?: string;
        application?: OfficeApplication;
      },
    ) => Promise<number[]>;
    officeTest: {
      ready: boolean;
      errors: number;
      saved: number[][];
      holdSaves: boolean;
      pending: number[][];
      session: OfficeSession | null;
      bridge?: ReturnType<
        (typeof import("../../app/lib/cryptpadBridge"))["openCryptPad"]
      >;
    };
  }
}

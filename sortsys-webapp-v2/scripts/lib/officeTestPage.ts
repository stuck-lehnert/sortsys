import assert from "node:assert/strict";
import { build, serve } from "bun";
import JSZip from "jszip";
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

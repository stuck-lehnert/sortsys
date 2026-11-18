import {
  buildGaebTypst,
  gaebEmbeddedImageFiles,
  compileTypst,
  downloadPdf,
  createGaebXml,
  deriveGaebDocument,
  GaebDocument,
  type GaebLocale,
} from "@sortsys/gaeb";
import { client, templateAssets } from "./client";
import { readTemplateResource } from "./data/printTemplateData";
import { renderPrintSvg, validatePrintAssetBytes } from "./data/printAssetBytes";
import { uiText } from "./i18n";
import { organizationSender } from "./organizationSender";
import type { QueryResult } from "@sortsys/v2-client";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import release from "../../vendor/pdfjs/release.json";
export type DocumentTemplate = QueryResult<"settings.documentTemplate.get">;
export type TemplateAsset = DocumentTemplate["assets"][number];
type PreparedAsset = { paths: string[]; files: Record<string, Uint8Array> };
type AssetEntry = { promise: Promise<PreparedAsset>; value?: PreparedAsset; users: number };
const cache = new Map<string, AssetEntry>();
function erase(prepared: PreparedAsset) { for (const bytes of new Set(Object.values(prepared.files))) bytes.fill(0); }
function trimCache() {
  let size = [...cache.values()].reduce((sum, entry) => sum + (entry.value ? [...new Set(Object.values(entry.value.files))].reduce((size, bytes) => size + bytes.byteLength, 0) : 0), 0);
  for (const [key, entry] of cache) {
    if (cache.size <= 40 && size <= 128 * 1024 * 1024) break;
    if (!entry.users && entry.value) {
      size -= [...new Set(Object.values(entry.value.files))].reduce((sum, bytes) => sum + bytes.byteLength, 0);
      cache.delete(key); erase(entry.value);
    }
  }
}
templateAssets.listenContext(() => { for (const entry of cache.values()) if (entry.value) erase(entry.value); cache.clear(); });
async function png(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Image conversion failed")),
      "image/png",
    ),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
async function prepareAsset(asset: TemplateAsset, signal: AbortSignal): Promise<PreparedAsset> {
  signal.throwIfAborted();
  if (!asset.downloadUrl) throw new Error(uiText("Die Vorlagendatei ist nicht verfügbar.", "The template asset is unavailable."));
  const resource = readTemplateResource(asset.downloadUrl);
  if (resource.id !== asset.id) throw new Error("Invalid template asset binding");
  const original = await templateAssets.blob(resource.id, resource.version, signal);
  signal.throwIfAborted();
  if (original.size !== asset.sizeBytes || original.type !== asset.mimeType) throw new Error("Invalid template asset metadata");
  const bytes = new Uint8Array(await original.arrayBuffer());
  const files: Record<string, Uint8Array> = {}, paths: string[] = [];
  let complete = false;
  const add = (data: Uint8Array) => { const path = `/assets/${asset.id}/${paths.length + 1}.png`; paths.push(path); files[path] = data; };
  try {
    validatePrintAssetBytes(asset.mimeType, bytes); signal.throwIfAborted();
    if (asset.mimeType === "application/pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
      const base = `${import.meta.env.BASE_URL}pdfjs/${release.version}/web/`;
      const task = pdfjs.getDocument({ data: bytes, enableXfa: false,
        standardFontDataUrl: base + "standard_fonts/", cMapUrl: base + "cmaps/", cMapPacked: true, wasmUrl: base + "wasm/" });
      const abort = () => { void task.destroy().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted(); const pdf = await task.promise; signal.throwIfAborted();
        if (pdf.numPages > 100) throw new Error(uiText("PDF-Vorlagen dürfen höchstens 100 Seiten haben.", "PDF template assets may contain at most 100 pages."));
        let total = 0;
        for (let index = 1; index <= pdf.numPages; index++) {
          signal.throwIfAborted();
          const page = await pdf.getPage(index), size = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, Math.sqrt(8_000_000 / (size.width * size.height))) });
          const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          try {
            const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
            await page.render({ canvas, canvasContext: context, viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise; signal.throwIfAborted();
            const data = await png(canvas); signal.throwIfAborted(); total += data.length;
            if (total > 128 * 1024 * 1024) { data.fill(0); throw new Error(uiText("Die PDF-Bilder benötigen zu viel Speicher.", "Rendered PDF pages require too much memory.")); }
            add(data);
          } finally { canvas.width = canvas.height = 0; page.cleanup(); }
        }
      } finally { signal.removeEventListener("abort", abort); await task.destroy().catch(() => undefined); }
    } else {
      const rendered = asset.mimeType === "image/svg+xml" ? new Blob([renderPrintSvg(bytes)], { type: asset.mimeType }) : original;
      const url = URL.createObjectURL(rendered), image = new Image();
      const abort = () => { image.src = ""; };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted(); image.src = url; await image.decode(); signal.throwIfAborted();
        const scale = Math.min(1, Math.sqrt(8_000_000 / (image.naturalWidth * image.naturalHeight)));
        const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        try {
          const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas unavailable");
          context.drawImage(image, 0, 0, canvas.width, canvas.height); add(await png(canvas)); signal.throwIfAborted();
          files[`/assets/${asset.name}`] = files[paths[0]!]!;
        } finally { canvas.width = canvas.height = 0; }
      } finally { signal.removeEventListener("abort", abort); URL.revokeObjectURL(url); image.src = ""; }
    }
    signal.throwIfAborted(); complete = true; return { paths, files };
  } finally {
    try { bytes.fill(0); } catch { /* PDF.js transfers its input to the worker. */ }
    if (!complete) erase({ paths, files });
  }
}
export async function prepareTemplateAssets(assets: TemplateAsset[], cancellation?: AbortSignal) {
  const context = templateAssets.context(), active = cancellation ? AbortSignal.any([context, cancellation]) : context;
  const paths: Record<string, string[]> = {}, files: Record<string, Uint8Array> = {};
  let allocated = 0;
  const dispose = () => { erase({ paths: [], files }); context.removeEventListener("abort", dispose); };
  context.addEventListener("abort", dispose, { once: true });
  try {
    active.throwIfAborted();
    for (const asset of assets) {
      const key = JSON.stringify([asset.id, asset.downloadUrl, asset.name, asset.mimeType, asset.sizeBytes]);
      let entry = cache.get(key);
      if (!entry) {
        const created: AssetEntry = { promise: Promise.resolve({ paths: [], files: {} }), users: 0 };
        created.promise = prepareAsset(asset, context).then(prepared => {
          if (context.aborted || context !== templateAssets.context()) { erase(prepared); throw new DOMException("Aborted", "AbortError"); }
          created.value = prepared; return prepared;
        }).catch(error => { if (cache.get(key) === created) cache.delete(key); throw error; });
        entry = created; cache.set(key, created);
      }
      entry.users++;
      try {
        const prepared = await entry.promise; active.throwIfAborted();
        paths[asset.name] = [...prepared.paths];
        const copies = new Map<Uint8Array, Uint8Array>();
        for (const [path, bytes] of Object.entries(prepared.files)) {
          let copy = copies.get(bytes);
          if (!copy) {
            allocated += bytes.byteLength;
            if (allocated > 128 * 1024 * 1024) throw new Error(uiText("Die Vorlagendateien benötigen zu viel Speicher.", "Template assets require too much memory."));
            copy = new Uint8Array(bytes); copies.set(bytes, copy);
          }
          files[path] = copy;
        }
      } finally { entry.users--; trimCache(); }
    }
    active.throwIfAborted();
    if ([...new Set(Object.values(files))].reduce((total, bytes) => total + bytes.byteLength, 0) > 128 * 1024 * 1024)
      throw new Error(uiText("Die Vorlagendateien benötigen zu viel Speicher.", "Template assets require too much memory."));
    return { paths, files, context: active, dispose };
  } catch (error) { dispose(); throw error; }
}
export async function loadPrintContext() {
  const [[template, error], [organization, profileError]] = await Promise.all([
    client.query("settings.documentTemplate.get", undefined, {
      strategy: "network-first",
    }),
    client.query("settings.organization.get", undefined, {
      strategy: "network-first",
    }),
  ]);
  if (error || profileError || !template || !organization)
    throw error ?? profileError ?? new Error("load-failed");
  return { template, organization };
}
export async function renderGaebPdf(
  xml: string,
  fileName: string,
  locale: GaebLocale,
  referenceXml: string | undefined,
  source: string | undefined,
  context: Awaited<ReturnType<typeof loadPrintContext>> & {
    projectTitle?: string;
    documentKind?: string;
  },
  signal?: AbortSignal,
) {
  const assets = await prepareTemplateAssets(context.template.assets, signal);
  try {
    const sender = organizationSender(context.organization);
    const code = buildGaebTypst(xml, fileName, locale, referenceXml, {
      template: source ?? context.template.source ?? undefined,
      assetPaths: assets.paths,
      sender: { name: sender?.name ?? "", address: sender?.lines ?? [] },
      projectTitle: context.projectTitle,
      documentKind: context.documentKind,
    });
    const result = await compileTypst(
      code,
      { ...assets.files, ...gaebEmbeddedImageFiles(xml, referenceXml) },
      assets.context,
    );
    assets.context.throwIfAborted();
    return result;
  } finally {
    assets.dispose();
  }
}
export async function exportGaebPdf(
  xml: string,
  fileName: string,
  locale: GaebLocale,
  referenceXml?: string,
  documentContext: { projectTitle?: string; documentKind?: string } = {},
) {
  const context = await loadPrintContext();
  downloadPdf(
    await renderGaebPdf(xml, fileName, locale, referenceXml, undefined, {
      ...context,
      ...documentContext,
    }),
    fileName,
  );
}
export function previewOffer(
  context: Awaited<ReturnType<typeof loadPrintContext>>,
) {
  let source = new GaebDocument(
    createGaebXml("83", "Beispiel Bauvorhaben"),
    "Beispiel.x83",
  );
  source = new GaebDocument(source.addItem(), source.fileName);
  source = new GaebDocument(
    source.setRichText(
      source.items[0],
      0,
      uiText("Dämmung liefern und montieren", "Supply and install insulation"),
    ),
    source.fileName,
  );
  source = new GaebDocument(
    source.setValue(source.items[0], "Qty", "3.000"),
    source.fileName,
  );
  source = new GaebDocument(
    source.setValue(source.items[0], "QU", "m²"),
    source.fileName,
  );
  let offer = new GaebDocument(
    deriveGaebDocument(source.source, "84", {
      ownCompany: context.organization.companyName ?? undefined,
      ownAddress: context.organization.address,
    }),
    "Beispiel.x84",
  );
  offer = new GaebDocument(
    offer.setValue(offer.items[0], "UP", "592.000"),
    offer.fileName,
  );
  return { xml: offer.source, reference: source.source };
}

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
import { client } from "./client";
import { uiText } from "./i18n";
import type { QueryResult } from "@sortsys/v2-client";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import release from "../../vendor/pdfjs/release.json";
export type DocumentTemplate = QueryResult<"settings.documentTemplate.get">;
export type TemplateAsset = DocumentTemplate["assets"][number];
type PreparedAsset = { paths: string[]; files: Record<string, Uint8Array> };
const cache = new Map<string, Promise<PreparedAsset>>();
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
async function prepareAsset(asset: TemplateAsset): Promise<PreparedAsset> {
  if (!asset.downloadUrl)
    throw new Error(
      uiText(
        "Die Vorlagendatei ist nicht verfügbar.",
        "The template asset is unavailable.",
      ),
    );
  const response = await fetch(asset.downloadUrl);
  if (!response.ok)
    throw new Error(
      uiText(
        "Die Vorlagendatei konnte nicht geladen werden.",
        "The template asset could not be loaded.",
      ),
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024)
    throw new Error(
      uiText(
        "Die Vorlagendatei ist zu groß.",
        "The template asset is too large.",
      ),
    );
  const files: Record<string, Uint8Array> = {},
    paths: string[] = [];
  const add = (data: Uint8Array) => {
    const path = `/assets/${asset.id}/${paths.length + 1}.png`;
    paths.push(path);
    files[path] = data;
  };
  if (asset.mimeType === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
    const base = `${import.meta.env.BASE_URL}pdfjs/${release.version}/web/`;
    const task = pdfjs.getDocument({
      data: bytes,
      enableXfa: false,
      standardFontDataUrl: base + "standard_fonts/",
      cMapUrl: base + "cmaps/",
      cMapPacked: true,
      wasmUrl: base + "wasm/",
    });
    const document = await task.promise;
    try {
      if (document.numPages > 100)
        throw new Error(
          uiText(
            "PDF-Vorlagen dürfen höchstens 100 Seiten haben.",
            "PDF template assets may contain at most 100 pages.",
          ),
        );
      let total = 0;
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index),
          original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.min(
            2,
            Math.sqrt(8_000_000 / (original.width * original.height)),
          ),
        });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const data = await png(canvas);
        total += data.length;
        if (total > 128 * 1024 * 1024)
          throw new Error(
            uiText(
              "Die PDF-Bilder benötigen zu viel Speicher.",
              "Rendered PDF pages require too much memory.",
            ),
          );
        add(data);
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: asset.mimeType }),
    );
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const scale = Math.min(
        1,
        Math.sqrt(8_000_000 / (image.naturalWidth * image.naturalHeight)),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      add(await png(canvas));
      files[`/assets/${asset.name}`] = files[paths[0]];
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return { paths, files };
}
export async function prepareTemplateAssets(assets: TemplateAsset[]) {
  const paths: Record<string, string[]> = {},
    files: Record<string, Uint8Array> = {};
  for (const asset of assets) {
    let pending = cache.get(asset.id);
    if (!pending) {
      pending = prepareAsset(asset).catch((error) => {
        cache.delete(asset.id);
        throw error;
      });
      if (cache.size > 40) cache.clear();
      cache.set(asset.id, pending);
    }
    const prepared = await pending;
    paths[asset.name] = prepared.paths;
    Object.assign(files, prepared.files);
  }
  const buffers = new Set(Object.values(files));
  if (
    [...buffers].reduce((total, bytes) => total + bytes.byteLength, 0) >
    128 * 1024 * 1024
  )
    throw new Error(
      uiText(
        "Die Vorlagendateien benötigen zu viel Speicher.",
        "Template assets require too much memory.",
      ),
    );
  return { paths, files };
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
  const assets = await prepareTemplateAssets(context.template.assets);
  const address = context.organization.address;
  const sender = {
    name: context.organization.companyName ?? "",
    address: address
      ? [
          address.streetAddress,
          [address.zip, address.city].filter(Boolean).join(" "),
          address.country ?? "",
        ].filter(Boolean)
      : [],
  };
  const code = buildGaebTypst(xml, fileName, locale, referenceXml, {
    template: source ?? context.template.source ?? undefined,
    assetPaths: assets.paths,
    sender,
    projectTitle: context.projectTitle,
    documentKind: context.documentKind,
  });
  return compileTypst(
    code,
    { ...assets.files, ...gaebEmbeddedImageFiles(xml, referenceXml) },
    signal,
  );
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

import {
  createPdfBusinessContext,
  pdfImagePath,
  pdfImageExtension,
} from "@sortsys/business-logic/pdf";
import {
  createPdfRenderer,
  type PdfDocumentLayout,
  type PdfTableCell,
  type PdfTableAlign,
  type PdfStyledCell,
  type PdfTableSection,
  type PdfCardItem,
  type PdfProductRow,
  type PdfCard,
  type PdfCardSection,
  type PdfSignatureField,
  type PdfImage,
  type PdfImageSection,
  type StructuredPdfDocument,
  type PdfDocumentGroup,
  type PreparedPdfImage,
  type PreparedPdfImageSection,
  type PreparedStructuredPdfDocument,
  type BuildPdfDocumentBodyOptions,
} from "@sortsys/business-logic/pdf";
export type {
  PdfTableCell,
  PdfTableAlign,
  PdfStyledCell,
  PdfTableSection,
  PdfCardItem,
  PdfProductRow,
  PdfCard,
  PdfCardSection,
  PdfSignatureField,
  PdfImage,
  PdfImageSection,
  StructuredPdfDocument,
  PdfDocumentGroup,
  PreparedPdfImage,
  PreparedPdfImageSection,
  PreparedStructuredPdfDocument,
  BuildPdfDocumentBodyOptions,
} from "@sortsys/business-logic/pdf";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";

import { PDF_FONT_FAMILY } from "@sortsys/business-logic/pdf";
const PDF_FONT_URLS = [
  new URL(
    "../../../sortsys-business-logic/assets/fonts/nimbus-sans-l/NimbusSanL-Regu.ttf",
    import.meta.url,
  ).href,
  new URL(
    "../../../sortsys-business-logic/assets/fonts/nimbus-sans-l/NimbusSanL-Bold.ttf",
    import.meta.url,
  ).href,
];
export type {
  PdfAddress,
  PdfInformation,
  PdfDocumentLayout,
} from "@sortsys/business-logic/pdf";

type RenderStructuredPdfBatchOptions = {
  documents: StructuredPdfDocument[];
};

let typstPdfRuntimeSetup: Promise<void> | null = null;
let typstPdfFontSetup: Promise<void> | null = null;
const TYPST_COMPILER_WASM_URL = new URL(
  "../../node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
  import.meta.url,
).href;
const MAX_TENANT_FONT_BYTES = 4 * 1024 * 1024;
const MAX_TENANT_LOGO_BYTES = 10 * 1024 * 1024;
const MAX_PDF_IMAGE_BYTES = 14 * 1024 * 1024;

function buildTenantLogoShadowPath(bytes: Uint8Array) {
  const extension =
    bytes[0] === 137 && bytes[1] === 80
      ? "png"
      : bytes[0] === 255 && bytes[1] === 216
        ? "jpeg"
        : "webp";
  return `/logo.${extension}`;
}
function buildPdfImageShadowPath(image: PdfImage, index: number) {
  return pdfImagePath(image, index);
}

async function fetchTenantLogoBytes() {
  const [tenantLogo, tenantLogoErr] = await client.query(
    "settings.tenantLogo.get",
    undefined,
    { strategy: "network-first" },
  );
  if (tenantLogoErr) return null;
  if (!tenantLogo?.downloadUrl) return null;

  const response = await fetch(tenantLogo.downloadUrl);
  if (!response.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  if (
    !arrayBuffer.byteLength ||
    arrayBuffer.byteLength > MAX_TENANT_LOGO_BYTES
  ) {
    return null;
  }

  return new Uint8Array(arrayBuffer);
}

async function prepareTenantLogoShadow($typst: any) {
  try {
    const bytes = await fetchTenantLogoBytes();
    if (!bytes?.length) return null;

    const shadowPath = buildTenantLogoShadowPath(bytes);
    await $typst.mapShadow(shadowPath, bytes);
    return shadowPath;
  } catch {
    return null;
  }
}

async function cleanupTenantLogoShadow($typst: any, shadowPath: string | null) {
  if (!shadowPath) return;

  try {
    await $typst.unmapShadow(shadowPath);
  } catch {
    // no-op
  }
}

async function fetchPdfImageBytes(image: PdfImage) {
  const response = await fetch(image.url);
  if (!response.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_PDF_IMAGE_BYTES) {
    return null;
  }

  return new Uint8Array(arrayBuffer);
}

async function preparePdfImageSections(
  $typst: any,
  documents: StructuredPdfDocument[],
) {
  const shadowPaths: string[] = [];
  let imageIndex = 0;
  const preparedDocuments: PreparedStructuredPdfDocument[] = [];

  for (const document of documents) {
    const imageSections: PreparedPdfImageSection[] = [];

    for (const section of document.imageSections ?? []) {
      const images: PreparedPdfImage[] = [];

      for (const image of section.images) {
        let shadowPath: string | null = null;
        try {
          const bytes = await fetchPdfImageBytes(image);
          if (bytes?.length) {
            shadowPath = buildPdfImageShadowPath(image, imageIndex);
            await $typst.mapShadow(shadowPath, bytes);
            shadowPaths.push(shadowPath);
          }
        } catch {
          shadowPath = null;
        }

        imageIndex++;
        images.push({ ...image, shadowPath });
      }

      imageSections.push({ ...section, images });
    }

    preparedDocuments.push({ ...document, imageSections });
  }

  return { documents: preparedDocuments, shadowPaths };
}

async function cleanupPdfImageShadows($typst: any, shadowPaths: string[]) {
  for (const shadowPath of shadowPaths) {
    try {
      await $typst.unmapShadow(shadowPath);
    } catch {
      // no-op
    }
  }
}

async function loadPdfFontBytes() {
  return Promise.all(
    PDF_FONT_URLS.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(
          uiText(
            "Die PDF-Schrift Nimbus Sans L konnte nicht geladen werden.",
            "The PDF font Nimbus Sans L could not be loaded.",
          ),
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_TENANT_FONT_BYTES) {
        throw new Error(
          uiText(
            "Die PDF-Schrift Nimbus Sans L ist ungültig.",
            "The PDF font Nimbus Sans L is invalid.",
          ),
        );
      }
      return bytes;
    }),
  );
}

async function ensureTypstPdfRuntime($typst: any) {
  if (typstPdfRuntimeSetup) {
    return typstPdfRuntimeSetup;
  }

  typstPdfRuntimeSetup = (async () => {
    const fonts = await loadPdfFontBytes();
    const compilerModule =
      (await import("@myriaddreamin/typst-ts-web-compiler")) as any;

    if (typeof compilerModule?.setImportWasmModule === "function") {
      compilerModule.setImportWasmModule(async () => TYPST_COMPILER_WASM_URL);
    }

    const typstModule = (await import("@myriaddreamin/typst.ts")) as any;

    let didSetInitOptions = false;
    try {
      const beforeBuild =
        typeof typstModule?.loadFonts === "function"
          ? [typstModule.loadFonts(fonts, { assets: false })]
          : [];

      $typst.setCompilerInitOptions({
        getModule: () => TYPST_COMPILER_WASM_URL,
        beforeBuild,
      });
      didSetInitOptions = true;
    } catch {
      // compiler already initialized
    }

    if (!didSetInitOptions) {
      if (!typstPdfFontSetup) {
        typstPdfFontSetup = (async () => {
          if (
            typeof typstModule?.createTypstFontBuilder !== "function" ||
            typeof $typst?.getCompiler !== "function"
          ) {
            throw new Error(
              uiText(
                "Die PDF-Schrift Nimbus Sans L konnte nicht geladen werden.",
                "The PDF font Nimbus Sans L could not be loaded.",
              ),
            );
          }

          const fontBuilder = typstModule.createTypstFontBuilder();
          await fontBuilder.init({
            beforeBuild: [],
            getModule: () => TYPST_COMPILER_WASM_URL,
          });

          for (const bytes of fonts) {
            await fontBuilder.addFontData(bytes);
          }

          const compiler = await $typst.getCompiler();
          await fontBuilder.build(async (fonts: any) => {
            compiler.setFonts(fonts);
          });
        })();
      }

      await typstPdfFontSetup;
    }
  })().catch((error) => {
    typstPdfRuntimeSetup = null;
    typstPdfFontSetup = null;
    throw error;
  });

  return typstPdfRuntimeSetup;
}

async function withTenantSender(documents: PreparedStructuredPdfDocument[]) {
  if (documents.every((document) => document.layout?.sender)) return documents;
  const [info] = await client.query("auth.sessionInfo", undefined, {
    strategy: "cache-first",
  });
  return documents.map((document) => ({
    ...document,
    layout: {
      ...document.layout,
      kind: document.layout?.kind ?? "report",
      sender: document.layout?.sender ?? {
        name: info?.tenant.companyName ?? "sortsys",
        lines: [],
      },
    },
  }));
}
let pdfQueue: Promise<void> = Promise.resolve();
export function renderStructuredPdfBatch(
  options: RenderStructuredPdfBatchOptions,
): Promise<Uint8Array> {
  const run = pdfQueue.then(() => renderStructuredPdfBatchNow(options));
  pdfQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function renderStructuredPdfBatchNow(
  options: RenderStructuredPdfBatchOptions,
): Promise<Uint8Array> {
  if (!options.documents.length) {
    throw new Error(uiText("Die PDF konnte nicht erstellt werden."));
  }

  const { $typst } = await import("@myriaddreamin/typst.ts");
  await ensureTypstPdfRuntime($typst);

  const logoShadowPath = await prepareTenantLogoShadow($typst);
  const preparedImages = await preparePdfImageSections(
    $typst,
    options.documents,
  );

  try {
    const mainContent = buildPdfBatchDocument(
      { documents: await withTenantSender(preparedImages.documents) },
      logoShadowPath,
    );
    const pdfData = await $typst.pdf({ mainContent });
    if (!pdfData?.length) {
      throw new Error(uiText("Die PDF konnte nicht erstellt werden."));
    }

    return pdfData as Uint8Array;
  } finally {
    await cleanupPdfImageShadows($typst, preparedImages.shadowPaths);
    await cleanupTenantLogoShadow($typst, logoShadowPath);
  }
}

export async function renderStructuredPdf(
  options: StructuredPdfDocument,
): Promise<Uint8Array> {
  return renderStructuredPdfBatch({ documents: [options] });
}

const renderer = () => createPdfBusinessContext(currentLocaleTag());
export function formatPdfNumber(value: number) {
  return renderer().formatPdfNumber(value);
}
export function buildPdfProductSection(
  rows: PdfProductRow[],
  options: { showPrices?: boolean; showNumbers?: boolean } = {},
) {
  return renderer().buildPdfProductSection(rows, options);
}
export function buildPdfBatchDocument(
  options: { documents: PreparedStructuredPdfDocument[] },
  logoShadowPath: string | null,
) {
  return renderer().buildPdfBatchDocument(options, logoShadowPath);
}

import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { MAX_DOCUMENT_ARCHIVE_BYTES } from "./boundedZip";

export type FileInspection = {
  thumbnail?: Blob;
  width?: number;
  height?: number;
  text?: string;
  textMethod?: string;
  pages?: number;
  textFailed?: boolean;
};

type FileDetails = { name: string; mime: string };
type TextFormat = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "csv";
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const textFormats = new Map<string, TextFormat>([
  ["application/pdf", "pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx",
  ],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx",
  ],
  ["text/plain", "txt"],
  ["text/csv", "csv"],
]);
const textExtensions = [...textFormats.values()];

function mimeType(mime: string): string {
  return mime.split(";", 1)[0]!.trim().toLowerCase();
}

function textFormat(mime: string, name: string): TextFormat | undefined {
  const specified = textFormats.get(mime);
  if (specified) return specified;
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return textExtensions.find((format) => format === extension);
}

function textLines() {
  const lines: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  return {
    add(line: string) {
      bytes += encoder.encode(line).length + Number(lines.length > 0);
      if (bytes > MAX_TEXT_BYTES) throw new InvalidProtectedData();
      lines.push(line);
    },
    text: () => lines.join("\n"),
  };
}

async function inspectImage(
  file: Blob,
  signal?: AbortSignal,
): Promise<FileInspection> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return {};
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    signal?.throwIfAborted();
    if (bitmap.width * bitmap.height > 64_000_000) return {};
    const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return {};
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const thumbnail = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.8),
    );
    signal?.throwIfAborted();
    if (!thumbnail) return {};
    return { thumbnail, width: canvas.width, height: canvas.height };
  } catch {
    signal?.throwIfAborted();
    return {};
  } finally {
    bitmap?.close();
  }
}

async function inspectPdf(
  file: Blob,
  signal?: AbortSignal,
): Promise<FileInspection> {
  if (typeof window === "undefined") return {};
  const [pdfjs, worker, buffer] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs?url"),
    file.arrayBuffer(),
  ]);
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    enableXfa: false,
    disableFontFace: true,
  });
  let destroying: Promise<void> | undefined;
  const destroy = () => (destroying ??= task.destroy().catch(() => undefined));
  const abort = () => {
    void destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await task.promise;
    signal?.throwIfAborted();
    if (pdf.numPages > 1000) return { textFailed: true };
    const lines = textLines();
    for (let index = 1; index <= pdf.numPages; index++) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(index);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        lines.add(text);
      } finally {
        page.cleanup();
      }
    }
    signal?.throwIfAborted();
    return {
      text: lines.text(),
      textMethod: "pdfjs-browser",
      pages: pdf.numPages,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    await destroy();
  }
}

/** Preview and search metadata are optional and computed before publication. */
export async function inspectProjectFile(
  file: Blob,
  signal?: AbortSignal,
  details?: FileDetails,
): Promise<FileInspection> {
  signal?.throwIfAborted();
  let mime = mimeType(file.type);
  if (!mime || mime === "application/octet-stream") {
    mime = mimeType(details?.mime ?? "");
  }
  if (mime.startsWith("image/")) return inspectImage(file, signal);
  let name = details?.name ?? "";
  if (!name && typeof File !== "undefined" && file instanceof File) {
    name = file.name;
  }
  const format = textFormat(mime, name);
  if (!format) return {};

  try {
    if (format === "pdf") return await inspectPdf(file, signal);
    if (format === "txt" || format === "csv") {
      if (file.size > MAX_TEXT_BYTES) return { textFailed: true };
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const text = decoder.decode(await file.arrayBuffer());
      signal?.throwIfAborted();
      if (text.includes("\0")) return { textFailed: true };
      return { text, textMethod: "utf8-browser" };
    }

    if (file.size > MAX_DOCUMENT_ARCHIVE_BYTES) return { textFailed: true };
    if (format === "xlsx") {
      const { importSpreadsheetText } = await import("./importSpreadsheet");
      const text = await importSpreadsheetText(await file.arrayBuffer(), signal);
      return { text, textMethod: "xlsx-browser" };
    }
    if (typeof DOMParser === "undefined") return {};
    const { readOfficeText } = await import("./officeText");
    const lines = textLines();
    await readOfficeText(await file.arrayBuffer(), format, lines.add, signal);
    signal?.throwIfAborted();
    return { text: lines.text(), textMethod: `${format}-browser` };
  } catch {
    signal?.throwIfAborted();
    return { textFailed: true };
  }
}

import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { LiveLlmRequest } from "./liveLlm";
import { uiText } from "./i18n";
import { prepareImportImage } from "./importImage";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export function importMime(file: File): string {
  const extension = file.name.toLowerCase().split(".").at(-1) ?? "";
  const fallback: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    xlsx: XLSX_MIME,
  };
  return file.type && file.type !== "application/octet-stream"
    ? file.type
    : (fallback[extension] ?? "");
}
async function spreadsheet(file: File, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const worker = new Worker(
    new URL("../workers/importSpreadsheet.ts", import.meta.url),
    { type: "module" },
  );
  try {
    return await new Promise<string>((resolve, reject) => {
      const cancel = () =>
        finish(new DOMException("Processing interrupted", "AbortError"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        reject(new InvalidProtectedData());
      }, 30_000);
      const finish = (value: string | Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        value instanceof Error ? reject(value) : resolve(value);
      };
      worker.onmessage = (event) => {
        const value = event.data?.text;
        finish(typeof value === "string" ? value : new InvalidProtectedData());
      };
      worker.onerror = () => finish(new InvalidProtectedData());
      signal.addEventListener("abort", cancel, { once: true });
      worker.postMessage(bytes, [bytes]);
      if (signal.aborted) cancel();
    });
  } finally {
    worker.terminate();
  }
}
export async function prepareImportFiles(
  files: readonly File[],
  signal: AbortSignal,
  readSpreadsheet: (
    file: File,
    signal: AbortSignal,
  ) => Promise<string> = spreadsheet,
): Promise<Extract<LiveLlmRequest, { kind: "document_import" }>> {
  signal.throwIfAborted();
  if (
    !files.length ||
    files.length > 20 ||
    files.some((file) => !file.size || file.size > 20 * 1024 * 1024) ||
    files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024
  ) {
    throw new Error(
      uiText(
        "Die ausgewählten Dateien überschreiten die zulässige Anzahl oder Größe.",
        "The selected files exceed the allowed number or size.",
      ),
    );
  }
  const request: Extract<LiveLlmRequest, { kind: "document_import" }> = {
    kind: "document_import",
    files: [],
    fileNames: [],
    text: "",
  };
  for (const file of files) {
    signal.throwIfAborted();
    const mime = importMime(file),
      name = file.name || "document-photo.jpg";
    if (name.includes("\0") || new TextEncoder().encode(name).length > 512)
      throw new InvalidProtectedData();
    request.fileNames.push(name);
    if (mime === XLSX_MIME) {
      const text = await readSpreadsheet(file, signal);
      signal.throwIfAborted();
      request.text += `\n--- file: ${name} ---\n${text}`;
      if (new TextEncoder().encode(request.text).length > 1_500_000)
        throw new Error(
          uiText(
            "Die Tabellen enthalten zu viel Text für einen Einlesevorgang.",
            "The spreadsheets contain too much text for one operation.",
          ),
        );
    } else if (mime === "image/jpeg")
      request.files.push({
        name,
        mime,
        blob: await prepareImportImage(file, signal),
      });
    else if (["application/pdf", "image/png", "image/webp"].includes(mime))
      request.files.push({ name, mime, blob: file });
    else
      throw new Error(
        uiText(
          "Erlaubt sind PDF-, XLSX-, JPG-, PNG- und WebP-Dateien.",
          "PDF, XLSX, JPG, PNG and WebP files are allowed.",
        ),
      );
  }
  if (
    request.files.reduce((total, file) => total + file.blob.size, 0) >
    100 * 1024 * 1024
  )
    throw new InvalidProtectedData();
  return request;
}

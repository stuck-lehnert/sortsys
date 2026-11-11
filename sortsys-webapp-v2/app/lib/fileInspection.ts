import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

/** Optional preview/search data is prepared locally. An unreadable preview does
 * not replace or reject an otherwise valid original, and never starts OCR jobs. */
export async function inspectProjectFile(file: Blob, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (file.type.toLowerCase().startsWith("image/")) {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file); signal?.throwIfAborted();
      if (bitmap.width * bitmap.height > 64_000_000) return {};
      const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d"); if (!context) return {};
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const thumbnail = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.8)); signal?.throwIfAborted();
      return thumbnail ? { thumbnail, width: canvas.width, height: canvas.height } : {};
    } catch { signal?.throwIfAborted(); return {}; }
    finally { bitmap?.close(); }
  }
  if (file.type.toLowerCase() === "application/pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), enableXfa: false, disableFontFace: true });
    const abort = () => { void task.destroy(); }; signal?.addEventListener("abort", abort, { once: true });
    try {
      const document = await task.promise; signal?.throwIfAborted();
      if (document.numPages > 1000) return { textFailed: true };
      const text: string[] = []; let length = 0;
      for (let index = 1; index <= document.numPages; index++) {
        signal?.throwIfAborted(); const page = await document.getPage(index), content = await page.getTextContent();
        const line = content.items.map(item => "str" in item ? item.str : "").join(" ");
        length += line.length; if (length > 4 * 1024 * 1024) return { textFailed: true };
        text.push(line); page.cleanup();
      }
      return { text: text.join("\n"), pages: document.numPages };
    } catch { signal?.throwIfAborted(); return { textFailed: true }; }
    finally { signal?.removeEventListener("abort", abort); await task.destroy(); }
  }
  return {};
}

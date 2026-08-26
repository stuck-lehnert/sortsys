import type { CadDocument, DwgParserSettings, PlanSource } from "../types.ts";
import { loadSourceBytes } from "../core/source.ts";
import DwgParserWorker from "./dwg.worker.ts?worker&inline";

export type ParseDwgOptions = DwgParserSettings & {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type WorkerResponse =
  | { type: "success"; requestId: string; document: CadDocument }
  | { type: "error"; requestId: string; message: string };

function createParserWorker() {
  return new DwgParserWorker({
    name: "sortsys-dwg-parser",
  });
}

export async function parseDwgDocument(source: PlanSource, options: ParseDwgOptions = {}): Promise<CadDocument> {
  if (options.signal?.aborted) throw new DOMException("DWG parsing aborted", "AbortError");

  const bytes = await loadSourceBytes(source);
  const worker = createParserWorker();
  const requestId = `dwg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  return await new Promise<CadDocument>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 30000;
    let timeout: ReturnType<typeof setTimeout> | null = timeoutMs > 0
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`DWG parser worker did not respond within ${timeoutMs / 1000} seconds.`));
        }, timeoutMs)
      : null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException("DWG parsing aborted", "AbortError"));
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.requestId !== requestId) return;

      cleanup();
      if (response.type === "success") {
        resolve(response.document);
      } else {
        reject(new Error(response.message));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "DWG parser worker failed."));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    worker.postMessage({
      type: "parse",
      requestId,
      bytes,
      rust: options.rust,
    }, [bytes]);
  });
}

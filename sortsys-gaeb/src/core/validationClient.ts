import type { GaebSchemaIdentity, GaebValidation } from "./types";

export function validateGaebInBrowser(
  source: string,
  identity: GaebSchemaIdentity,
  signal?: AbortSignal,
): Promise<GaebValidation> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./gaebValidation.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("validation-timeout"));
    }, 25_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<GaebValidation>) => {
      finish();
      resolve(event.data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("validation-failed"));
    };
    worker.postMessage({ source, identity });
  });
}

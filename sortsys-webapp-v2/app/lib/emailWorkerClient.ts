import type { EmailFormat } from "./attachmentPreview";
import type { EmailPreview } from "./emailPreview";

export type EmailWorkerRequest = {
  bytes: ArrayBuffer;
  format: EmailFormat;
  mode: "preview" | "text";
};

export type EmailWorkerResponse =
  | { mode: "preview"; value: EmailPreview }
  | { mode: "text"; value: string }
  | { error: string };

export function readEmailInWorker(
  bytes: ArrayBuffer,
  format: EmailFormat,
  mode: "preview",
  signal?: AbortSignal,
): Promise<EmailPreview>;
export function readEmailInWorker(
  bytes: ArrayBuffer,
  format: EmailFormat,
  mode: "text",
  signal?: AbortSignal,
): Promise<string>;
export async function readEmailInWorker(
  bytes: ArrayBuffer,
  format: EmailFormat,
  mode: EmailWorkerRequest["mode"],
  signal?: AbortSignal,
): Promise<EmailPreview | string> {
  signal?.throwIfAborted();
  // Terminating the worker also stops a stalled parser for a compound file.
  const worker = new Worker(new URL("./emailPreview.worker.ts", import.meta.url), { type: "module" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;

  try {
    return await new Promise<EmailPreview | string>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => reject(new Error("email-timeout")), 20_000);
      worker.onmessage = ({ data }: MessageEvent<EmailWorkerResponse>) => {
        if ("error" in data) reject(new Error(data.error));
        else if (data.mode === mode) resolve(data.value);
        else reject(new Error("invalid-email"));
      };
      worker.onerror = () => reject(new Error("invalid-email"));
      worker.postMessage({ bytes, format, mode } satisfies EmailWorkerRequest, [bytes]);
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
    worker.terminate();
  }
}

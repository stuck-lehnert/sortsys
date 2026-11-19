import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type JSZip from "jszip";

export const MAX_DOCUMENT_ARCHIVE_BYTES = 20 * 1024 * 1024;

export async function openDocumentArchive(buffer: ArrayBuffer) {
  if (buffer.byteLength > MAX_DOCUMENT_ARCHIVE_BYTES) {
    throw new InvalidProtectedData();
  }

  const { default: Zip } = await import("jszip");
  const archive = await Zip.loadAsync(buffer);
  if (Object.keys(archive.files).length > 10_000) {
    throw new InvalidProtectedData();
  }
  return archive;
}

/** Apply caller-owned limits before an inflated entry is fully materialized. */
export async function visitArchiveEntry(
  entry: JSZip.JSZipObject,
  consume: (chunk: Uint8Array) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  // JSZip's streaming reader is present at runtime but omitted on ZipObject
  // in its type declarations.
  const reader = entry as JSZip.JSZipObject & {
    internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
  };
  if (typeof reader.internalStream !== "function")
    throw new InvalidProtectedData();

  const stream = reader.internalStream("uint8array");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error === undefined) {
        resolve();
      } else {
        stream.pause();
        reject(error);
      }
    }
    const abort = () => finish(signal?.reason ?? new InvalidProtectedData());
    signal?.addEventListener("abort", abort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        try {
          consume(chunk);
        } catch (error) {
          finish(error ?? new InvalidProtectedData());
        }
      })
      .on("end", () => finish())
      .on("error", () => finish(new InvalidProtectedData()))
      .resume();
  });
}

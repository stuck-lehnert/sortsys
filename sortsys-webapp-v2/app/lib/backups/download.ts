type BackupFile = {
  createWritable(): Promise<WritableStream<Uint8Array>>;
};

type BackupFilePicker = (options: {
  suggestedName: string;
}) => Promise<BackupFile>;

export function backupFilePicker(): BackupFilePicker | undefined {
  const browser = window as Window & { showSaveFilePicker?: BackupFilePicker };
  return browser.showSaveFilePicker?.bind(browser);
}

/** When a file picker is available, wait for the user before contacting the
 * API, and publish the destination only after receiving the exact byte count. */
export async function downloadBackup(
  name: string,
  bytes: number,
  request: () => Promise<Response>,
  signal: AbortSignal,
  chooseFile?: BackupFilePicker,
): Promise<Blob | null> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("Invalid backup size");
  }
  let destination: BackupFile | undefined;
  if (chooseFile) {
    try {
      destination = await chooseFile({ suggestedName: name });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
  }
  signal.throwIfAborted();
  const response = await request();
  const body = response.body;
  const length = response.headers.get("content-length");
  if (
    signal.aborted ||
    response.status !== 200 ||
    !body ||
    (length !== null && length !== String(bytes))
  ) {
    await body?.cancel();
    signal.throwIfAborted();
    throw new Error("Invalid backup response");
  }
  let remaining = bytes;
  const verifySize = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      remaining -= chunk.byteLength;
      if (remaining < 0) throw new Error("Backup response is too large");
      controller.enqueue(chunk);
    },
    flush() {
      if (remaining !== 0) throw new Error("Backup response is incomplete");
    },
  });
  if (!destination) {
    return new Response(body.pipeThrough(verifySize, { signal }), {
      headers: { "content-type": "application/octet-stream" },
    }).blob();
  }
  let writable: WritableStream<Uint8Array>;
  try {
    writable = await destination.createWritable();
  } catch (error) {
    await body.cancel();
    throw error;
  }
  await body.pipeThrough(verifySize, { signal }).pipeTo(writable, { signal });
  return null;
}

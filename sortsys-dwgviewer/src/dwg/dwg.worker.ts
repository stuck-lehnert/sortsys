import { parseDwgWithRust } from "./rustRuntime.ts";

const parseTimeoutMs = 30000;

type ParseMessage = {
  type: "parse";
  requestId: string;
  bytes: ArrayBuffer;
  rust?: {
    wasmUrl?: string;
  };
};

async function withParseTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(
            `Rust DWG parser did not respond within ${parseTimeoutMs / 1000} seconds.`,
          ));
        }, parseTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

self.onmessage = async (event: MessageEvent<ParseMessage>) => {
  const message = event.data;
  if (message.type !== "parse") return;

  try {
    const document = await withParseTimeout(
      parseDwgWithRust(message.bytes, message.rust),
    );

    self.postMessage({
      type: "success",
      requestId: message.requestId,
      document,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      requestId: message.requestId,
      message: (err as Error)?.message || `${err}`,
    });
  }
};

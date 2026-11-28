import { InvalidProtectedData } from "./encoding";

export type OtsHttpOptions = {
  fetch?: (url: string, options: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const OTS_HTTP_PRIVACY = {
  credentials: "omit",
  redirect: "error",
  referrerPolicy: "no-referrer",
  mode: "cors",
} as const;

export function otsRequestSignal(timeoutMs?: number, signal?: AbortSignal) {
  const timeout = timeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new InvalidProtectedData();
  }

  const deadline = AbortSignal.timeout(timeout);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  cancellation.throwIfAborted();
  return cancellation;
}

export async function readOtsBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;

      length += part.value.length;
      if (length > limit) throw new InvalidProtectedData();
      if (part.value.length > 0) chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

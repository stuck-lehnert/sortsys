import { InvalidProtectedData } from "./encoding";
import type { OtsBlockSource } from "./otsCalendars";

const SOURCES = ["https://blockstream.info/api", "https://mempool.space/api"] as const;
type Options = { fetch?: (url: string, options: RequestInit) => Promise<Response>; timeoutMs?: number };
const hex = (data: Uint8Array) => Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
/** This is an explicit trust choice, not an SPV node: two independent HTTPS
 * explorers must agree on the canonical hash at the exact height, with at
 * least six confirmations. Neither receives a document commitment or ID.
 * Reference endpoints: https://github.com/Blockstream/esplora/blob/master/API.md */
export function publicOtsBlockSource(options: Options = {}): OtsBlockSource {
  const cache = new Map<number, Promise<{ height: number; header: Uint8Array<ArrayBuffer> }>>();
  async function text(origin: typeof SOURCES[number], path: string, signal?: AbortSignal): Promise<string> {
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new InvalidProtectedData();
    const cancellation = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    cancellation.throwIfAborted();
    const response = await (options.fetch ?? fetch)(origin + path, { signal: cancellation, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", mode: "cors" });
    if (!response.ok || !response.body) throw new InvalidProtectedData();
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true }); let result = "", length = 0;
    try { for (;;) { cancellation.throwIfAborted(); const part = await reader.read(); cancellation.throwIfAborted(); if (part.done) break;
      length += part.value.length; if (length > 1024) throw new InvalidProtectedData(); result += decoder.decode(part.value, { stream: true });
    } result += decoder.decode(); } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return result.trim();
  }
  async function block(height: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(height) || height < 0 || height > 100_000_000) throw new InvalidProtectedData();
    const replies = await Promise.all(SOURCES.map(async origin => {
      const [id, tip] = await Promise.all([text(origin, `/block-height/${height}`, signal), text(origin, "/blocks/tip/height", signal)]);
      if (!/^[a-f0-9]{64}$/.test(id) || !/^(?:0|[1-9]\d{0,8})$/.test(tip) || Number(tip) - height < 5) throw new InvalidProtectedData();
      const raw = await text(origin, `/block/${id}/header`, signal);
      if (!/^[a-f0-9]{160}$/.test(raw)) throw new InvalidProtectedData();
      const header = Uint8Array.from(raw.match(/../g)!, pair => Number.parseInt(pair, 16));
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await crypto.subtle.digest("SHA-256", header)));
      if (hex(digest.reverse()) !== id) throw new InvalidProtectedData(); return { id, raw, header };
    }));
    signal?.throwIfAborted();
    if (replies[0]!.id !== replies[1]!.id || replies[0]!.raw !== replies[1]!.raw) throw new InvalidProtectedData();
    return { height, header: replies[0]!.header };
  }
  return async (height, signal) => {
    signal?.throwIfAborted(); let pending = cache.get(height);
    if (!pending) { pending = block(height, signal); cache.set(height, pending); }
    try { const value = await pending; signal?.throwIfAborted(); return { height: value.height, header: value.header.slice() }; }
    catch (error) { if (cache.get(height) === pending) cache.delete(height); throw error; }
  };
}

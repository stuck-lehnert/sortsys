import { InvalidProtectedData } from "./encoding";
import type { OtsBlockSource } from "./otsCalendars";
import {
  OTS_HTTP_PRIVACY,
  otsRequestSignal,
  readOtsBody,
  type OtsHttpOptions,
} from "./otsHttp";

const SOURCES = ["https://blockstream.info/api", "https://mempool.space/api"] as const;
type Options = Omit<OtsHttpOptions, "signal">;
const hex = (data: Uint8Array) => Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
/** This is an explicit trust choice, not an SPV node: two independent HTTPS
 * explorers must agree on the canonical hash at the exact height, with at
 * least six confirmations. Neither receives a document commitment or ID.
 * Reference endpoints: https://github.com/Blockstream/esplora/blob/master/API.md */
export function publicOtsBlockSource(options: Options = {}): OtsBlockSource {
  const cache = new Map<number, Promise<{ height: number; header: Uint8Array<ArrayBuffer> }>>();
  async function text(origin: typeof SOURCES[number], path: string, signal?: AbortSignal): Promise<string> {
    const cancellation = otsRequestSignal(options.timeoutMs, signal);
    const response = await (options.fetch ?? fetch)(origin + path, {
      ...OTS_HTTP_PRIVACY,
      signal: cancellation,
    });
    if (!response.ok || !response.body) throw new InvalidProtectedData();

    const bytes = await readOtsBody(response.body, 1024, cancellation);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
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

import { expect, test } from "bun:test";
import { publicOtsBlockSource } from "../src/sortsys";
// Bitcoin genesis header: public chain data, unrelated to any sortsys record.
const header = "01000000" + "00".repeat(32) + "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" + "29ab5f49ffff001d1dac2b7c";
const hash = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
function fixture(change: (url: string, value: string) => string = (_, value) => value) {
  const calls: { url: string; options: RequestInit }[] = [];
  const source = publicOtsBlockSource({ fetch: async (url, options) => {
    calls.push({ url, options });
    const value = url.endsWith("/blocks/tip/height") ? "100" : url.endsWith("/block-height/0") ? hash : url.endsWith(`/block/${hash}/header`) ? header : "unexpected";
    return new Response(change(url, value));
  } });
  return { calls, source };
}
test("two independent canonical sources must agree at the exact height; only public block references are requested", async () => {
  const f = fixture(), block = await f.source(0); expect(block.height).toBe(0); expect(Buffer.from(block.header).toString("hex")).toBe(header);
  expect(f.calls.length).toBe(6);
  expect(new Set(f.calls.map(call => new URL(call.url).hostname))).toEqual(new Set(["blockstream.info", "mempool.space"]));
  for (const { options } of f.calls) { expect(options.credentials).toBe("omit"); expect(options.redirect).toBe("error"); expect(options.referrerPolicy).toBe("no-referrer"); expect(options.body).toBeUndefined(); }
  block.header.fill(0); expect(Buffer.from((await f.source(0)).header).toString("hex")).toBe(header); expect(f.calls.length).toBe(6);
});
test("a block with fewer than six confirmations or a source disagreement remains unverified", async () => {
  for (const f of [fixture((url, value) => url.endsWith("tip/height") ? "4" : value), fixture((url, value) => url.includes("mempool.space") && url.includes("block-height") ? "f".repeat(64) : value)]) await expect(f.source(0)).rejects.toThrow();
});
test("changed headers, unexpected payloads and oversized replies fail closed and do not poison the cache", async () => {
  let invalid = true;
  const f = fixture((url, value) => invalid && url.endsWith("/header") ? "0".repeat(160) : value);
  await expect(f.source(0)).rejects.toThrow(); invalid = false; expect((await f.source(0)).header.length).toBe(80);
  for (const replacement of ["x".repeat(1025), "abc", "01".repeat(81)]) await expect(fixture((url, value) => url.endsWith("/header") ? replacement : value).source(0)).rejects.toThrow();
});
test("abort and invalid heights never start a public request", async () => {
  const f = fixture(); await expect(f.source(0, AbortSignal.abort())).rejects.toThrow();
  for (const height of [-1, 0.5, NaN, 100_000_001]) await expect(f.source(height)).rejects.toThrow(); expect(f.calls.length).toBe(0);
});

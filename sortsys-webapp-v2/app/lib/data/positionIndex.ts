import {
  digest,
  bytes,
  InvalidProtectedData,
  record,
} from "@sortsys/zerotrust/sortsys";
import type { GaebPositionSuggestion } from "@sortsys/gaeb";
import { documentMicros } from "@sortsys/zerotrust/sortsys";

export type PositionSource = {
  id: string;
  version: string;
  fileName: string;
  modifiedAt: string;
  read(signal: AbortSignal): Promise<string>;
};
type Text = Pick<GaebPositionSuggestion, "shortText" | "description" | "unit">;
type Cached = { positions: Text[]; size: number };
const BUDGET = 32 * 1024 * 1024;
const MAX_SOURCE_READS = 4;
const words = (text: string) =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A disposable RAM index. Cold searches advance in bounded batches; only
 * the twenty newest distinct matches are retained for the current query. */
export function createPositionIndex(
  sources: () => Promise<PositionSource[]>,
  extract: (xml: string, signal: AbortSignal) => Promise<Text[]>,
  signal: AbortSignal,
) {
  const cache = new Map<string, Cached>();
  let used = 0,
    closed = false,
    pending: Promise<unknown> = Promise.resolve();
  let request = new AbortController();
  let state = {
    query: "",
    inventory: "",
    cursor: 0,
    found: new Map<string, GaebPositionSuggestion>(),
  };
  const live = () => {
    signal.throwIfAborted();
    if (closed) throw new InvalidProtectedData();
  };
  function close() {
    closed = true;
    request.abort();
    cache.clear();
    used = 0;
    state.found.clear();
    state.inventory = "";
    state.query = "";
  }
  signal.addEventListener("abort", close, { once: true });
  return {
    close() {
      close();
      signal.removeEventListener("abort", close);
    },
    invalidate() {
      request.abort();
      state = { query: "", inventory: "", cursor: 0, found: new Map() };
    },
    search(input: unknown) {
      request.abort();
      request = new AbortController();
      const current = AbortSignal.any([signal, request.signal]);
      const active = () => {
        live();
        current.throwIfAborted();
      };
      const task = pending.then(async () => {
        active();
        const data = record(input, ["query"]);
        if (typeof data.query !== "string" || [...data.query].length > 200)
          throw new InvalidProtectedData();
        const query = words(data.query).slice(0, 12),
          all = (await sources())
            .map((source) => ({
              ...source,
              modified: BigInt(documentMicros(source.modifiedAt)),
            }))
            .sort((a, b) =>
              a.modified === b.modified
                ? a.id.localeCompare(b.id)
                : a.modified > b.modified
                  ? -1
                  : 1,
            );
        active();
        const keys = all.map((source) =>
            JSON.stringify([source.id, source.version, source.fileName]),
          ),
          allowed = new Set(keys);
        for (const [key, value] of cache)
          if (!allowed.has(key)) {
            cache.delete(key);
            used -= value.size;
          }
        const inventory = JSON.stringify(keys),
          search = JSON.stringify(query);
        if (state.query !== search || state.inventory !== inventory)
          state = { query: search, inventory, cursor: 0, found: new Map() };
        let remainingSourceReads = MAX_SOURCE_READS;
        let loadedSources: PromiseSettledResult<string>[] = [];
        while (state.cursor < all.length && state.found.size < 20) {
          const index = state.cursor,
            source = all[index]!,
            key = keys[index]!;
          let cached = cache.get(key);
          // Retire this response even if an earlier source filled its cache entry.
          let prefetchedSource = loadedSources.shift();
          if (!cached) {
            if (!prefetchedSource) {
              if (remainingSourceReads === 0) break;
              const group: PositionSource[] = [];
              for (
                let next = index;
                next < all.length && group.length < remainingSourceReads;
                next++
              ) {
                if (cache.has(keys[next]!)) break;
                group.push(all[next]!);
              }
              remainingSourceReads -= group.length;
              // Start independent reads together so their encrypted RPCs can
              // share the transport window. Consume results by source rank.
              loadedSources = await Promise.allSettled(
                group.map(async (entry) => entry.read(current)),
              );
              active();
              prefetchedSource = loadedSources.shift()!;
            }
            if (prefetchedSource.status === "rejected") {
              throw prefetchedSource.reason;
            }
            const positions = await extract(prefetchedSource.value, current);
            active();
            const size = bytes(JSON.stringify(positions)).length;
            cached = { positions, size };
            if (size <= BUDGET) {
              while (used + size > BUDGET && cache.size) {
                const first = cache.keys().next().value!;
                used -= cache.get(first)!.size;
                cache.delete(first);
              }
              cache.set(key, cached);
              used += size;
            }
          } else {
            cache.delete(key);
            cache.set(key, cached);
          }
          for (const position of cached.positions) {
            const tokens = words(
              position.shortText + " " + position.description,
            );
            if (
              !query.every((part) =>
                tokens.some((token) => token.startsWith(part)),
              )
            )
              continue;
            const fingerprint = JSON.stringify([
              position.shortText,
              position.description,
              position.unit,
            ]);
            if (state.found.has(fingerprint)) continue;
            const id = await digest(bytes(fingerprint));
            active();
            state.found.set(fingerprint, {
              ...position,
              id,
              sourceFile: source.fileName,
            });
            if (state.found.size === 20) break;
          }
          state.cursor++;
        }
        active();
        return {
          items: [...state.found.values()].map((item) => ({ ...item })),
          indexing: state.cursor < all.length && state.found.size < 20,
        };
      });
      pending = task.catch(() => undefined);
      return task;
    },
  };
}

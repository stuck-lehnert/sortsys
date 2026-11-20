import {
  createDocumentMatcher,
  createDocumentTokenizer,
  matchDocuments,
  MAX_CACHED_DOCUMENT_WORDS,
  type SearchDocument,
  type SearchMatch,
} from "./documentQuery";

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_RETAINED_BYTES = 8 * MAX_BATCH_BYTES;
const MAX_BATCH_DOCUMENTS = 16;
type Batch = {
  id: number;
  bytes: number;
  documents: SearchDocument[];
  retain: boolean;
  loaded: boolean;
};
type DocumentGroup = readonly SearchDocument[];
type BatchInput = {
  batch: number;
  source?: { documents: SearchDocument[]; retain: boolean };
};
export type SearchRequest =
  | { discard: number[] }
  | { query: string; batches: BatchInput[] };
export type SearchResponse = { matches: SearchMatch[] } | { failed: true };

function* boundedChunks<T>(
  input: Iterable<T>,
  size: (item: T) => { bytes: number; count: number },
) {
  let items: T[] = [];
  let bytes = 0;
  let count = 0;
  for (const item of input) {
    const next = size(item);
    if (
      items.length &&
      (count + next.count > MAX_BATCH_DOCUMENTS || bytes + next.bytes > MAX_BATCH_BYTES)
    ) {
      yield { items, bytes };
      items = [];
      bytes = 0;
      count = 0;
    }
    items.push(item);
    bytes += next.bytes;
    count += next.count;
  }
  if (items.length) yield { items, bytes };
}

function documentSize({ id, name, text }: SearchDocument) {
  const characters = id.length + name.length + (text?.length ?? 0);
  return { bytes: 64 + characters * 2, count: 1 };
}

type WorkerState = {
  worker: Worker;
  groups: Map<DocumentGroup, Batch[]>;
  nextBatch: number;
  cancelRequest?: (error: Error) => void;
};

/** Keep bounded groups of verified documents in one worker per adapter. */
export function createDocumentSearch() {
  let snapshot: WorkerState | undefined;
  let nativeTokenizer: ReturnType<typeof createDocumentTokenizer> | undefined;
  let nativeGroups = new Set<DocumentGroup>();
  let searchController: AbortController | undefined;
  let pending = Promise.resolve();

  function discardWorker() {
    const current = snapshot;
    snapshot = undefined;
    current?.worker.terminate();
    current?.cancelRequest?.(
      new DOMException("Document search cleared", "AbortError"),
    );
  }

  function clear() {
    searchController?.abort();
    discardWorker();
    nativeTokenizer = undefined;
    nativeGroups.clear();
  }

  function request(current: WorkerState, input: SearchRequest) {
    const { worker } = current;
    return new Promise<SearchMatch[]>((resolve, reject) => {
      function finish() {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        current.cancelRequest = undefined;
      }

      function fail(error: Error) {
        finish();
        if (snapshot === current) discardWorker();
        reject(error);
      }

      current.cancelRequest = fail;
      worker.onmessage = (event: MessageEvent<SearchResponse>) => {
        if (
          !event.data ||
          !("matches" in event.data) ||
          !Array.isArray(event.data.matches)
        ) {
          fail(new Error("Local document search failed"));
          return;
        }
        finish();
        resolve(event.data.matches);
      };
      worker.onerror = worker.onmessageerror = () =>
        fail(new Error("Local document search worker failed"));
      try {
        worker.postMessage(input);
      } catch {
        fail(new Error("Local document search worker failed"));
      }
    });
  }

  async function prepareGroups(current: WorkerState, groups: Set<DocumentGroup>) {
    const discarded: number[] = [];
    let remainingBytes = MAX_RETAINED_BYTES;
    for (const [group, batches] of current.groups) {
      if (groups.has(group)) {
        for (const batch of batches) {
          if (batch.retain) remainingBytes -= batch.bytes;
        }
      } else {
        for (const { id } of batches) discarded.push(id);
        current.groups.delete(group);
      }
    }
    if (discarded.length) await request(current, { discard: discarded });

    // Unchanged groups keep their budget before new groups are admitted.
    for (const group of groups) {
      if (current.groups.has(group)) continue;
      const batches: Batch[] = [];
      for (const { items, bytes } of boundedChunks(group, documentSize)) {
        const retain = bytes <= remainingBytes;
        if (retain) remainingBytes -= bytes;
        batches.push({
          documents: items,
          bytes,
          id: current.nextBatch++,
          retain,
          loaded: false,
        });
      }
      current.groups.set(group, batches);
    }
  }

  // Array identity represents a verified projection of one file collection.
  async function searchGroups(
    projections: readonly DocumentGroup[],
    query: string,
    signal: AbortSignal,
  ): Promise<SearchMatch[]> {
    signal.throwIfAborted();
    const groups = new Set(projections.filter(({ length }) => length > 0));
    if (typeof document === "undefined") {
      if ([...nativeGroups].some((group) => !groups.has(group))) {
        nativeTokenizer = undefined;
      }
      nativeGroups = groups;
      nativeTokenizer ??= createDocumentTokenizer(MAX_CACHED_DOCUMENT_WORDS);
      const matcher = createDocumentMatcher(query, nativeTokenizer);
      return [...groups].flatMap((group) => matchDocuments(matcher, group, { signal }));
    }

    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    const active = AbortSignal.any([signal, controller.signal]);
    const result = pending.then(async () => {
      active.throwIfAborted();
      if (!groups.size) {
        discardWorker();
        return [];
      }
      if (!snapshot) {
        snapshot = {
          groups: new Map(),
          nextBatch: 0,
          worker: new Worker(
            new URL("./documentSearch.worker.ts", import.meta.url),
            { type: "module" },
          ),
        };
      }
      const current = snapshot;
      await prepareGroups(current, groups);
      const matches: SearchMatch[] = [];
      const batches = [...groups].flatMap((group) => current.groups.get(group)!);
      for (const { items } of boundedChunks(batches, ({ bytes, documents }) => ({
        bytes,
        count: documents.length,
      }))) {
        active.throwIfAborted();
        const inputs = items.map((batch): BatchInput => {
          const input: BatchInput = { batch: batch.id };
          if (!batch.loaded) {
            input.source = { documents: batch.documents, retain: batch.retain };
          }
          return input;
        });
        const found = await request(current, { query, batches: inputs });
        for (const batch of items) batch.loaded = batch.retain;
        active.throwIfAborted();
        matches.push(...found);
      }
      return matches;
    });
    // Only one chunk is in flight. A superseded query leaves completed
    // chunks available and stops before sending another one.
    pending = result.then(() => undefined, () => undefined);
    try {
      return await result;
    } finally {
      if (searchController === controller) searchController = undefined;
    }
  }

  return {
    search(documents: DocumentGroup, query: string, signal: AbortSignal) {
      return searchGroups([documents], query, signal);
    },
    searchGroups,
    clear,
  };
}

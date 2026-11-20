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
  documents: SearchDocument[];
  retain: boolean;
  loaded: boolean;
};
export type SearchRequest = {
  query: string;
  batch: number;
  source?: { documents: SearchDocument[]; retain: boolean };
};
export type SearchResponse = { matches: SearchMatch[] } | { failed: true };

function planBatches(documents: readonly SearchDocument[]): Batch[] {
  const batches: Batch[] = [];
  let retained = 0;
  let parts: SearchDocument[] = [];
  let bytes = 0;
  function addBatch() {
    const retain = bytes <= MAX_RETAINED_BYTES - retained;
    if (retain) retained += bytes;
    batches.push({ documents: parts, retain, loaded: false });
    parts = [];
    bytes = 0;
  }
  for (const document of documents) {
    const characters =
      document.id.length + document.name.length + (document.text?.length ?? 0);
    const length = 64 + characters * 2;
    if (
      parts.length === MAX_BATCH_DOCUMENTS ||
      (parts.length && bytes + length > MAX_BATCH_BYTES)
    ) {
      addBatch();
    }
    parts.push(document);
    bytes += length;
  }
  if (parts.length) addBatch();
  return batches;
}

type WorkerSnapshot = {
  worker: Worker;
  documents: readonly SearchDocument[];
  batches: Batch[];
  cancelRequest?: (error: Error) => void;
};

/** Keep one bounded, verified document snapshot per adapter in the worker. */
export function createDocumentSearch() {
  let snapshot: WorkerSnapshot | undefined;
  let nativeTokenizer: ReturnType<typeof createDocumentTokenizer> | undefined;
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
  }

  function request(current: WorkerSnapshot, input: SearchRequest) {
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

  // Reuse the array identity only for the same verified scope and revisions.
  async function search(
    documents: readonly SearchDocument[],
    query: string,
    signal: AbortSignal,
  ): Promise<SearchMatch[]> {
    signal.throwIfAborted();
    if (typeof document === "undefined") {
      nativeTokenizer ??= createDocumentTokenizer(MAX_CACHED_DOCUMENT_WORDS);
      const matcher = createDocumentMatcher(query, nativeTokenizer);
      return matchDocuments(matcher, documents, signal);
    }

    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    const active = AbortSignal.any([signal, controller.signal]);
    const result = pending.then(async () => {
      active.throwIfAborted();
      if (snapshot?.documents !== documents) {
        discardWorker();
        snapshot = {
          documents,
          batches: planBatches(documents),
          worker: new Worker(
            new URL("./documentSearch.worker.ts", import.meta.url),
            { type: "module" },
          ),
        };
      }
      const current = snapshot;
      const matches: SearchMatch[] = [];
      for (const [index, batch] of current.batches.entries()) {
        active.throwIfAborted();
        const input: SearchRequest = { query, batch: index };
        if (!batch.loaded) {
          input.source = { documents: batch.documents, retain: batch.retain };
        }
        const found = await request(current, input);
        batch.loaded = batch.retain;
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

  return { search, clear };
}

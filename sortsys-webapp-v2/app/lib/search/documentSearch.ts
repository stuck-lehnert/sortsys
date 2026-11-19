import {
  createDocumentMatcher,
  createDocumentTokenizer,
  matchDocuments,
  MAX_CACHED_DOCUMENT_WORDS,
  type SearchDocument,
  type SearchMatch,
} from "./documentQuery";

export type SearchRequest = { query: string; documents: SearchDocument[] };

/** Bounded worker messages and token storage for one verified file adapter. */
export function createDocumentSearch() {
  let worker: Worker | undefined;
  let nativeTokenizer: ReturnType<typeof createDocumentTokenizer> | undefined;
  let cancel: (() => void) | undefined;

  function discard() {
    worker?.terminate();
    worker = undefined;
    nativeTokenizer = undefined;
  }

  function clear() {
    if (cancel) cancel();
    else discard();
  }

  async function search(
    documents: SearchDocument[],
    query: string,
    signal: AbortSignal,
  ): Promise<SearchMatch[]> {
    signal.throwIfAborted();
    if (typeof document === "undefined") {
      nativeTokenizer ??= createDocumentTokenizer(MAX_CACHED_DOCUMENT_WORDS);
      const matcher = createDocumentMatcher(query, nativeTokenizer);
      return matchDocuments(matcher, documents, signal);
    }

    if (cancel) clear();
    worker ??= new Worker(
      new URL("./documentSearch.worker.ts", import.meta.url),
      { type: "module" },
    );
    const current = worker;
    return new Promise<SearchMatch[]>((resolve, reject) => {
      const results: SearchMatch[] = [];
      let offset = 0;

      function finish() {
        signal.removeEventListener("abort", abort);
        current.onmessage = null;
        current.onerror = null;
        current.onmessageerror = null;
        cancel = undefined;
      }

      function fail(error: unknown) {
        finish();
        discard();
        reject(error);
      }

      const abort = () => fail(signal.reason);
      cancel = () =>
        fail(new DOMException("Document search cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });

      function next() {
        if (signal.aborted) return abort();
        if (offset >= documents.length) {
          finish();
          resolve(results);
          return;
        }
        const batch: SearchDocument[] = [];
        let size = 0;
        while (offset < documents.length && batch.length < 16) {
          const value = documents[offset]!;
          const length = (value.name.length + (value.text?.length ?? 0)) * 2;
          if (batch.length && size + length > 1024 * 1024) break;
          batch.push(value);
          offset++;
          size += length;
        }
        try {
          current.postMessage({ query, documents: batch } satisfies SearchRequest);
        } catch (error) {
          fail(error);
        }
      }

      current.onmessage = (
        event: MessageEvent<{ matches?: SearchMatch[]; failed?: boolean }>,
      ) => {
        if (event.data?.failed || !Array.isArray(event.data?.matches))
          return fail(new Error("Local document search failed"));
        results.push(...event.data.matches);
        next();
      };
      current.onerror = current.onmessageerror = () =>
        fail(new Error("Local document search worker failed"));
      next();
    });
  }

  return { search, clear };
}

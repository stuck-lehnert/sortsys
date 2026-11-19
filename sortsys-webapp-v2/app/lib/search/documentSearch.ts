import {
  createDocumentMatcher,
  matchDocuments,
  type SearchDocument,
  type SearchMatch,
} from "./documentQuery";

export type SearchRequest = { query: string; documents: SearchDocument[] };

/** A disposable worker owns no persistent plaintext cache. Bounded messages
 * avoid cloning a whole decrypted tenant catalogue into one worker request. */
export async function searchDocuments(
  documents: SearchDocument[],
  query: string,
  signal: AbortSignal,
): Promise<SearchMatch[]> {
  signal.throwIfAborted();
  if (typeof document === "undefined") {
    return matchDocuments(createDocumentMatcher(query), documents, signal);
  }
  const worker = new Worker(
    new URL("./documentSearch.worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    return await new Promise<SearchMatch[]>((resolve, reject) => {
      const results: SearchMatch[] = [];
      let offset = 0;
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      function finish(error?: unknown) {
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(results);
      }
      function next() {
        if (signal.aborted) return finish(signal.reason);
        if (offset >= documents.length) return finish();
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
        worker.postMessage({ query, documents: batch } satisfies SearchRequest);
      }
      worker.onmessage = (
        event: MessageEvent<{ matches?: SearchMatch[]; failed?: boolean }>,
      ) => {
        if (event.data.failed || !Array.isArray(event.data.matches))
          return finish(new Error("Local document search failed"));
        results.push(...event.data.matches);
        next();
      };
      worker.onerror = () =>
        finish(new Error("Local document search worker failed"));
      next();
    });
  } finally {
    worker.terminate();
  }
}

import {
  createDocumentMatcher,
  createDocumentTokenizer,
  matchDocuments,
  MAX_CACHED_DOCUMENT_WORDS,
  type SearchDocument,
} from "./documentQuery";
import type { SearchRequest, SearchResponse } from "./documentSearch";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(value: SearchResponse): void;
};
const tokenizer = createDocumentTokenizer(MAX_CACHED_DOCUMENT_WORDS);
const batches = new Map<number, SearchDocument[]>();
const textUsers = new Map<string, number>();
let current: {
  query: string;
  matcher: ReturnType<typeof createDocumentMatcher>;
} | null = null;

function discardBatches(ids: number[]) {
  const expired = new Set<string>();
  for (const id of ids) {
    const documents = batches.get(id);
    if (!documents) continue;
    batches.delete(id);
    for (const { text } of documents) {
      if (!text) continue;
      const remaining = (textUsers.get(text) ?? 1) - 1;
      if (remaining) {
        textUsers.set(text, remaining);
      } else {
        textUsers.delete(text);
        expired.add(text);
      }
    }
  }
  tokenizer.forget(expired);
}

scope.onmessage = (event) => {
  try {
    if ("discard" in event.data) {
      discardBatches(event.data.discard);
      scope.postMessage({ matches: [] });
      return;
    }
    const { query } = event.data;
    if (!current || current.query !== query)
      current = { query, matcher: createDocumentMatcher(query, tokenizer) };
    const matches = [];
    for (const { batch, source } of event.data.batches) {
      const documents = source?.documents ?? batches.get(batch);
      if (!documents) throw new Error("Missing document batch");
      if (source && batches.has(batch)) throw new Error("Duplicate document batch");
      matches.push(...matchDocuments(current.matcher, documents, {
        cacheText: source?.retain ?? true,
      }));
      if (source?.retain) {
        batches.set(batch, documents);
        for (const { text } of documents) {
          if (text) textUsers.set(text, (textUsers.get(text) ?? 0) + 1);
        }
      }
    }
    scope.postMessage({ matches });
  } catch {
    // Do not echo decrypted source text, queries or parser errors across errors.
    scope.postMessage({ failed: true });
  }
};

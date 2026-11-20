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
let current: {
  query: string;
  matcher: ReturnType<typeof createDocumentMatcher>;
} | null = null;
scope.onmessage = (event) => {
  try {
    const { query, batch, source } = event.data;
    const documents = source?.documents ?? batches.get(batch);
    if (!documents) throw new Error("Missing document batch");
    if (!current || current.query !== query)
      current = { query, matcher: createDocumentMatcher(query, tokenizer) };
    const matches = matchDocuments(current.matcher, documents);
    if (source?.retain) batches.set(batch, documents);
    scope.postMessage({ matches });
  } catch {
    // Do not echo decrypted source text, queries or parser errors across errors.
    scope.postMessage({ failed: true });
  }
};

import {
  createDocumentMatcher,
  createDocumentTokenizer,
  matchDocuments,
  MAX_CACHED_DOCUMENT_WORDS,
  type SearchMatch,
} from "./documentQuery";
import type { SearchRequest } from "./documentSearch";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(value: { matches: SearchMatch[] } | { failed: true }): void;
};
const tokenizer = createDocumentTokenizer(MAX_CACHED_DOCUMENT_WORDS);
let current: {
  query: string;
  matcher: ReturnType<typeof createDocumentMatcher>;
} | null = null;
scope.onmessage = (event) => {
  try {
    const { query, documents } = event.data;
    if (!current || current.query !== query)
      current = { query, matcher: createDocumentMatcher(query, tokenizer) };
    scope.postMessage({ matches: matchDocuments(current.matcher, documents) });
  } catch {
    // Do not echo decrypted source text, queries or parser errors across errors.
    scope.postMessage({ failed: true });
  }
};

import { createDocumentMatcher } from "./documentQuery";
import type { SearchRequest, SearchMatch } from "./documentSearch";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage(value: { matches: SearchMatch[] } | { failed: true }): void;
};
let current: {
  query: string;
  matcher: ReturnType<typeof createDocumentMatcher>;
} | null = null;
scope.onmessage = (event) => {
  try {
    const { query, documents } = event.data;
    if (!current || current.query !== query)
      current = { query, matcher: createDocumentMatcher(query) };
    const matches: SearchMatch[] = [];
    for (const document of documents) {
      const found = current.matcher.match(document.name, document.text);
      if (found) matches.push({ id: document.id, ...found });
    }
    scope.postMessage({ matches });
  } catch {
    // Do not echo decrypted source text, queries or parser errors across errors.
    scope.postMessage({ failed: true });
  }
};

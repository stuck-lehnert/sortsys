import { identifier, InvalidProtectedData } from "../encoding";

export function facetVocabulary(
  facets: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(facets) || !facets.length || facets.length > 256) {
    throw new InvalidProtectedData();
  }
  for (const facet of facets) identifier(facet);
  const vocabulary = new Set(facets);
  if (vocabulary.size !== facets.length) throw new InvalidProtectedData();
  return vocabulary;
}

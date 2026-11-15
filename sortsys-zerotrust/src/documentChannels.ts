import { DOCUMENT_FACETS, documentId, type DocumentFacet } from "./documents";
import { CREATION_FACETS } from "./creation";
import { InvalidProtectedData, record } from "./encoding";
import type { Facet } from "./objects";

export type DocumentRoom = { scope: string; document: string };
export type DocumentChannel = DocumentRoom & { facet: DocumentFacet };

export function documentChannel(input: unknown): DocumentChannel {
  const value = record(input, ["scope", "document", "facet"]);
  if (
    typeof value.scope !== "string" ||
    !/^(?:commercial|project):[1-9a-v][0-9a-v]{0,12}$/.test(value.scope)
  ) {
    throw new InvalidProtectedData();
  }
  documentId(value.scope.slice(value.scope.indexOf(":") + 1));
  documentId(value.document);
  if (
    typeof value.facet !== "string" ||
    !DOCUMENT_FACETS.includes(value.facet as DocumentFacet)
  ) {
    throw new InvalidProtectedData();
  }
  if (value.scope.startsWith("project:") && value.facet !== "attachment") {
    throw new InvalidProtectedData();
  }
  return value as DocumentChannel;
}

export function documentChannelKeys(
  input: DocumentChannel,
): readonly (typeof CREATION_FACETS.commercial)[number][] {
  const channel = documentChannel(input);
  if (channel.facet === "opaque") {
    return CREATION_FACETS.commercial;
  }
  return [channel.facet];
}

export function documentChannelOuter(input: DocumentChannel): Facet {
  const channel = documentChannel(input);
  if (channel.facet === "opaque") {
    return "scope";
  }
  return channel.facet;
}

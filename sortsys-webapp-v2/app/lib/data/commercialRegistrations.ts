import type { Client, QueryInput } from "@sortsys/v2-client";
import {
  documentTimestamp,
  encryptedObject,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { createDocumentHeadVerifier } from "../crypto/documentHeads";
import { unlockedAccount } from "../crypto/session";
import { commercialCollection, type CommercialFacet } from "./commercialAreas";
import { joinCommercialFacets } from "./commercialData";
import type { CaseSnapshot } from "./commercialSnapshot";
import { publicId } from "./products";
import { type protectedCollections, required } from "./protectedObjects";
import type { BusinessRow } from "./rowCodec";

type Collections = Awaited<ReturnType<typeof protectedCollections>>;

type View = Pick<
  QueryInput<"zerotrust.documents.registrations">,
  "sequence" | "prepared"
>;

export class RestoreDocumentConflict extends Error {}

export function checkConfirmationSources(
  saved: readonly BusinessRow[],
  retained: ReadonlyMap<string, BusinessRow>,
) {
  const orders = new Map(
    saved
      .filter(
        (row) =>
          row.table === "commercial_documents" && row.values.phase === "86",
      )
      .map((row) => [publicId(row.values.id), row]),
  );
  for (const confirmation of retained.values()) {
    if (
      confirmation.values.phase !== "87" ||
      confirmation.values.source_document_id === null
    )
      continue;
    const source = orders.get(publicId(confirmation.values.source_document_id));
    if (
      !source ||
      source.values.case_id !== confirmation.values.case_id ||
      confirmation.values.source_version === null ||
      BigInt(source.values.version as string) <
        BigInt(confirmation.values.source_version as string)
    )
      throw new RestoreDocumentConflict();
  }
}

export async function readRetainedDocumentRows(
  client: Client,
  signal: AbortSignal,
  caseId: string,
  collections: Collections,
  view: View,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  const scope = `commercial:${caseId}`;
  const verifier = createDocumentHeadVerifier(client, {
    account,
    scope,
    live,
    author: collections.controlAuthor,
  });
  const retained = new Map<string, BusinessRow>();
  let after: string | undefined;
  do {
    live();
    const page = await required(
      client.query(
        "zerotrust.documents.registrations",
        { scope, ...view, after },
        { strategy: "network-only" },
      ),
    );
    live();
    if (
      page.after !== null &&
      (!page.after.startsWith(`${scope}:`) ||
        (after !== undefined && page.after <= after))
    )
      throw new InvalidProtectedData();
    for (const entry of page.documents) {
      const head = await verifier.check(entry.head);
      if (!head.locked || retained.has(head.id)) throw new InvalidProtectedData();
      const facets = new Map<CommercialFacet, unknown>();
      for (const input of entry.facets) {
        const envelope = encryptedObject(input);
        const facet = envelope.facet as CommercialFacet;
        const area = commercialCollection(caseId, facet);
        if (!collections.readable(area) || facets.has(facet))
          throw new InvalidProtectedData();
        const collection = collections(area);
        try {
          const opened = await collection.openHistorical(
            envelope,
            `${area.prefix}case`,
          );
          facets.set(facet, opened.value);
        } finally {
          collection.close();
        }
      }
      const values = joinCommercialFacets(caseId, facets);
      const document = values.find(
        (row) =>
          row.table === "commercial_documents" &&
          publicId(row.values.id) === head.id,
      );
      if (
        !document ||
        document.values.version !== head.version ||
        document.values.read_only !== true ||
        Date.parse(document.values.modified_at as string) !==
          Date.parse(documentTimestamp(head.modifiedMicros))
      ) {
        throw new InvalidProtectedData();
      }
      retained.set(head.id, document);
      if (retained.size > 10000) throw new InvalidProtectedData();
    }
    after = page.after ?? undefined;
  } while (after !== undefined);
  live();
  return retained;
}

/** Project only the missing document row from the publication-time facets.
 * Every other row remains part of the older signed case. */
export async function includeRetainedDocuments(
  client: Client,
  signal: AbortSignal,
  basis: CaseSnapshot,
  collections: Collections,
): Promise<CaseSnapshot> {
  const master = basis.parts.get("master-data");
  if (!master?.signature) return basis;
  const retained = await readRetainedDocumentRows(
    client,
    signal,
    basis.id,
    collections,
    { sequence: master.head.sequence },
  );
  if (!retained.size) return basis;
  const additions = new Map(retained);
  const values = basis.values.map((row) => {
    if (row.table !== "commercial_documents") return row;
    const id = publicId(row.values.id);
    const registered = additions.get(id);
    if (!registered) return row;
    // An invoice seal can already supply the same immutable registration.
    if (!basis.seal || basis.seal.document.id !== id)
      throw new InvalidProtectedData();
    additions.delete(id);
    return registered;
  });
  return {
    ...basis,
    values: [...values, ...additions.values()],
    retainedDocuments: new Set(additions.keys()),
  };
}

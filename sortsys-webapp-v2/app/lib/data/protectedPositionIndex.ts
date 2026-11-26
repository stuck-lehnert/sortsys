import type { Client } from "@sortsys/v2-client";
import {
  browserGaebXml,
  gaebFilePhase,
  MAX_GAEB_BYTES,
  type GaebXmlProcessor,
} from "@sortsys/gaeb";
import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { commercialCollection, commercialDomain } from "./commercialAreas";
import { joinCommercialFacets } from "./commercialData";
import { commercialDocumentStore } from "./commercialDocumentContent";
import { fileCollection, fileDomainId, filePayload } from "./projectFileData";
import { loadFileContent } from "./fileContent";
import { publicId } from "./products";
import { protectedCollections, type Collection } from "./protectedObjects";
import { createPositionIndex, type PositionSource } from "./positionIndex";

/** Inventory and texts come exclusively from verified encrypted collections.
 * In commercial documents only scope is opened, even if prices are readable. */
export function createProtectedPositionIndex(
  client: Client,
  signal: AbortSignal,
  processor: GaebXmlProcessor = browserGaebXml,
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  type Store = {
    head: string;
    sources: PositionSource[];
  };
  const stores = new Map<string, Store>();
  let closed = false;
  let snapshot: PositionSource[] | null = null,
    generation = 0;
  const live = () => {
    signal.throwIfAborted();
    if (closed || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  async function sources() {
    live();
    if (snapshot) return snapshot;
    const started = generation;
    const open = await protectedCollections(client, signal);
    live();
    const areas = open.areas((domain) => {
      const part = commercialDomain(domain);
      if (part && ["master-data", "scope"].includes(part.facet))
        return commercialCollection(part.id, part.facet);
      const project = fileDomainId(domain);
      return project ? fileCollection(project) : null;
    });
    const scope = new Set(
      areas.filter((area) => area.facet === "scope").map((area) => area.scope),
    );
    const selected = areas.filter(
      (area) =>
        area.facet === "attachment" ||
        (area.facet === "master-data" && scope.has(area.scope)),
    );
    const visible = new Set(selected.map((area) => area.domain));
    for (const domain of stores.keys())
      if (!visible.has(domain)) stores.delete(domain);

    async function refresh({
      area,
      known,
    }: {
      area: Collection;
      known?: string;
    }) {
      const collection = open(area);
      try {
        const rows =
          known === undefined
            ? await collection.read()
            : await collection.readIfChanged(known);
        live();
        if (rows === null) return;
        const entries: PositionSource[] = [];
        const project = fileDomainId(area.domain);
        if (project)
          for (const row of rows) {
            const payload = filePayload(
                row.value,
                row.envelope.object,
                project,
              ),
              file = payload.file?.values,
              manifest = payload.original;
            if (
              !file ||
              !manifest ||
              file.status !== "uploaded" ||
              !gaebFilePhase(file.file_name as string)
            )
              continue;
            const id = publicId(file.id),
              fileName = file.file_name as string;
            entries.push({
              id: `file:${project}:${id}`,
              version: row.envelope.signature,
              fileName,
              modifiedAt: (file.office_modified_at ??
                file.created_at) as string,
              async read(cancellation) {
                const active = AbortSignal.any([signal, cancellation]);
                active.throwIfAborted();
                live();
                if (manifest.size > MAX_GAEB_BYTES)
                  throw new InvalidProtectedData();
                const blob = await loadFileContent(
                    client,
                    project,
                    id,
                    manifest,
                    file.mime_type as string,
                    active,
                  ),
                  bytes = new Uint8Array(await blob.arrayBuffer());
                try {
                  live();
                  active.throwIfAborted();
                  return new TextDecoder("utf-8", { fatal: true }).decode(
                    bytes,
                  );
                } finally {
                  bytes.fill(0);
                }
              },
            });
          }
        else {
          if (rows.length > 1) throw new InvalidProtectedData();
          if (rows[0]) {
            const row = rows[0],
              part = commercialDomain(area.domain)!;
            if (row.envelope.object !== area.prefix)
              throw new InvalidProtectedData();
            const value = joinCommercialFacets(
              part.id,
              new Map([["master-data", row.value]]),
            );
            for (const doc of value.filter(
              (row) => row.table === "commercial_documents",
            )) {
              const p = doc.values,
                id = publicId(p.id),
                version = p.version as string;
              entries.push({
                id: `commercial:${part.id}:${id}`,
                version: row.envelope.signature,
                fileName: p.file_name as string,
                modifiedAt: p.modified_at as string,
                async read(cancellation) {
                  const active = AbortSignal.any([signal, cancellation]);
                  active.throwIfAborted();
                  live();
                  const store = await commercialDocumentStore(
                    client,
                    area.scope,
                    active,
                  );
                  try {
                    const head = await store.head(id, version);
                    if (!head) throw new InvalidProtectedData();
                    return (await store.load(head, processor, true)).xml;
                  } finally {
                    store.close();
                  }
                },
              });
            }
          }
        }
        live();
        stores.set(area.domain, {
          head: collection.snapshot(),
          sources: entries,
        });
      } finally {
        collection.close();
      }
    }
    for (const batch of arrayBatches(selected, 8)) {
      const requests = batch.map((area) => ({
        area: {
          ...area,
          prefix: area.prefix + (area.facet === "attachment" ? "file:" : "case"),
        },
        known: stores.get(area.domain)?.head,
      }));
      await open.prefetch(requests);
      const result = await Promise.allSettled(requests.map(refresh));
      for (const item of result)
        if (item.status === "rejected") throw item.reason;
    }
    live();
    const result = [...stores.values()].flatMap((store) => store.sources);
    if (generation === started) snapshot = result;
    return result;
  }
  const index = createPositionIndex(
    sources,
    (xml, signal) => processor.positions(xml, signal),
    signal,
  );
  function close() {
    closed = true;
    snapshot = null;
    index.close();
    stores.clear();
  }
  signal.addEventListener("abort", close, { once: true });
  return {
    search: index.search,
    refresh() {
      generation++;
      snapshot = null;
      index.invalidate();
    },
    close() {
      signal.removeEventListener("abort", close);
      close();
    },
  };
}

import { expect, spyOn, test } from "bun:test";
import * as documentContent from "./commercialDocumentContent";
import { prepareCommercialDocuments } from "./migrateCommercialDocuments";
import { row } from "./testing/businessRow.mjs";

test("archived GAEB documents share one inventory but retain exact bytes and case-local lifetimes", async () => {
  const xml = "\uFEFF<GAEB>\r\n</GAEB>";
  const phase = "82";
  const originals = new Map([
    ["offer.xml", new Blob([xml])],
    ["invoice.xml", new Blob([xml])],
  ]);
  const tables = {
    commercial_cases: [
      { id: "2", kind: "offer", status: "draft" },
      { id: "3", kind: "invoice", status: "issued" },
    ],
    commercial_document_snapshots: [],
    commercial_documents: [
      { id: "4", case_id: "2", object_key: "offer.xml" },
      { id: "5", case_id: "3", object_key: "invoice.xml" },
    ].map((document) => ({
      ...document,
      phase,
      version: "1",
      size_bytes: String(originals.get(document.object_key).size),
    })),
  };
  const source = {
    async query(sql) {
      const table = sql.match(/ FROM "([^"]+)"$/)?.[1];
      return { rows: tables[table].map((values) => row(table, values).values) };
    },
  };

  const files = {
    async read({ key }) {
      return originals.get(key);
    },
  };
  const processor = {
    async partition(original, kind) {
      expect(original).toBe(xml);
      expect(["offer", "invoice"]).toContain(kind);
      return { xml: original, layout: { identity: { phase } } };
    },
  };

  const saved = new Map();
  const opened = [];
  const published = [];
  let active = null;

  function open(scope) {
    expect(active).toBeNull();
    active = scope;
    opened.push(scope);

    return {
      async head(id) {
        return saved.get(`${scope}/${id}`)?.head ?? null;
      },
      async prepare(id, partition, metadata) {
        return { head: { id, ...metadata }, xml: partition.xml };
      },
      async publish(publication) {
        saved.set(`${scope}/${publication.head.id}`, publication);
        published.push(publication.head);
      },
      async load(head) {
        return { complete: true, xml: saved.get(`${scope}/${head.id}`).xml };
      },
      close() {
        expect(active).toBe(scope);
        active = null;
      },
    };
  }

  const single = spyOn(documentContent, "commercialDocumentStore")
    .mockImplementation(async (_client, scope) => open(scope));
  const shared = spyOn(documentContent, "commercialDocumentStores")
    .mockResolvedValue(open);

  try {
    const client = {};
    const { signal } = new AbortController();
    const importDocuments = () =>
      prepareCommercialDocuments(client, source, signal, processor, files);

    await importDocuments();
    expect(opened).toEqual(["commercial:2", "commercial:3"]);
    expect(active).toBeNull();
    expect(shared).toHaveBeenCalledTimes(1);
    expect(shared).toHaveBeenCalledWith(client, signal, undefined);
    expect(single).not.toHaveBeenCalled();
    expect(published.map(({ id, locked, readOnly }) => [id, locked, readOnly])).toEqual([
      ["4", false, false],
      ["5", true, true],
    ]);

    await importDocuments();
    expect(published).toHaveLength(2);
    expect(shared).toHaveBeenCalledTimes(2);

    originals.set("offer.xml", new Blob([xml.replace("GAEB", "GAEa")]));
    await expect(importDocuments()).rejects.toThrow();
    expect(active).toBeNull();
    expect(published).toHaveLength(2);
  } finally {
    single.mockRestore();
    shared.mockRestore();
  }
});

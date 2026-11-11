import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import type { GaebXmlProcessor } from "@sortsys/gaeb";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { partitionGaebXml, renderGaebXml } from "../../sortsys-gaeb/src/core/privacy";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { validateGaebXml } from "../../sortsys-gaeb/src/core/validation";
import { extractPositionText } from "../../sortsys-gaeb/src/core/positionExtract";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareCommercialDocuments } from "../app/lib/data/migrateCommercialDocuments";
import { required } from "../app/lib/data/protectedObjects";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";

// The same libxml2-WASM parser and renderer as the real browser worker, without
// browser Worker transport in this disposable Node/Bun integration process.
const directory = fileURLToPath(new URL("../../sortsys-gaeb/vendor/gaeb", import.meta.url)), schemas: Record<string, string> = {};
for (const version of readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())) for (const name of readdirSync(join(directory, version.name)).filter(name => name.endsWith(".xsd"))) schemas[`${version.name}/${name}`] = readFileSync(join(directory, version.name, name), "utf8");
export const gaebTestProcessor: GaebXmlProcessor = {
  async positions(xml, signal) { signal.throwIfAborted(); return extractPositionText(xml); },
  async partition(xml, kind, signal) { signal.throwIfAborted(); return partitionGaebXml(xml, kind); },
  async render(layout, fragments, signal) { signal.throwIfAborted(); return renderGaebXml(layout, fragments); },
  async validate(xml, identity, signal) { signal.throwIfAborted(); return validateGaebXml(xml, identity, schemas); },
};
const processor = gaebTestProcessor;
export async function testProtectedGaebDocuments(client: Client, source: BusinessDatabase, driver: () => Promise<DuckDriver>, baseline: QueryResult<"commercial.cases.get">) {
  const requests: unknown[] = [], signal = new AbortController().signal;
  let losePublication = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input }); const result = await client.mutate(path, input, options);
      if (losePublication && path === "zerotrust.objects.batch" && Array.isArray((input as { documents?: unknown[] }).documents) && (input as { documents: unknown[] }).documents.length && !result[1]) {
        losePublication = false; return [null, new Error("Synthetic lost document publication acknowledgement")];
      }
      return result;
    }) as Client["mutate"],
  };
  console.log("Converting original GAEB XML into independent encrypted facets");
  await prepareCommercialDocuments(observed, source, signal, processor);
  await prepareCommercialDocuments(observed, source, signal, processor);
  console.log("All source GAEB files reopened byte-exactly; repeated encrypted conversion verified");
  const business = createBusinessClient(observed, { productDriver: driver, gaebProcessor: processor });
  const id = baseline.documents[0]!.id, caseId = baseline.case.id;
  try {
    const current = await required(business.query("commercial.documents.get", { caseId, id }));
    const original = createGaebXml("84", "Verschlüsselungstest Innenputz", "2026-11-10");
    assert.equal(current.xml, original); assert.equal(current.version, BigInt(baseline.documents[0]!.version));
    assert.equal(current.livePath, ""); assert.equal(current.recoveryScope, ""); assert.equal(current.canEdit, true);
    const edited = current.xml.replaceAll(encodeURIComponent("Verschlüsselungstest Innenputz"), encodeURIComponent("Bearbeitetes geschütztes Angebot"));
    losePublication = true;
    const saved = await required(business.mutate("commercial.documents.save", { caseId, id, version: current.version, xml: edited }));
    assert.equal(losePublication, false);
    assert.equal(saved.version, current.version + 1n);
    assert.equal((await required(business.query("commercial.documents.get", { caseId, id }))).xml, edited);
    const detail = await required(business.query("commercial.cases.get", { id: caseId }));
    assert.equal(detail.case.title, "Bearbeitetes geschütztes Angebot");
    assert.equal(detail.documents.find(document => document.id === id)!.version, saved.version);
    assert.ok((await business.mutate("commercial.documents.save", { caseId, id, version: current.version, xml: original }))[1], "Stale revisions must not overwrite a committed document");
    const store = await commercialDocumentStore(observed, `commercial:${caseId}`, signal);
    try {
      const head = await store.head(id); assert.ok(head);
      assert.equal((await store.load(head, processor)).xml, edited);
      const locked = await store.prepare(id, await processor.partition(edited + "\n", "offer", signal), { previous: head, modifiedAt: new Date().toISOString(), locked: true });
      await store.publish(locked);
      assert.equal((await required(business.query("commercial.documents.get", { caseId, id }))).canEdit, false);
      assert.ok((await business.mutate("commercial.documents.save", { caseId, id, version: BigInt(locked.head.version), xml: original }))[1]);
    } finally { store.close(); }
    for (const secret of ["Verschlüsselungstest Innenputz", "Bearbeitetes geschütztes Angebot", "<GAEB", "<BoQ"]) assert.equal(JSON.stringify(requests).includes(secret), false, `No business plaintext in requests: ${secret}`);
    console.log("Private GAEB verified: all seeded XML converted, resumable migration, byte-exact opening, ordinary edit/save, title/list synchronization, stale revision rejection, irreversible finalization and no plaintext RPC payloads.");
  } finally { business.dispose(); }
}

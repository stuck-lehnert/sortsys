import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import type { GaebXmlProcessor } from "@sortsys/gaeb";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import type { DuckDriver } from "../app/lib/data/database";
import { gaebWorkflowXml } from "./test-live-gaeb-workflows";

export async function testProtectedPositions(client: Client, driver: () => Promise<DuckDriver>, processor: GaebXmlProcessor, projectId: string) {
  const business = createBusinessClient(client, { productDriver: driver, gaebProcessor: processor });
  let search: ReturnType<typeof createBusinessClient> | null = null;
  const requests: unknown[] = [], keys: string[] = [];
  try {
    const current = await required(business.mutate("commercial.cases.create", { kind: "offer", title: "Positionsindex Prüfangebot", scopeItemIds: [] }));
    const xml = gaebWorkflowXml("83").replaceAll("Fensterlaibung", "Indexprivatlaibung");
    const doc = await required(business.mutate("commercial.documents.create", { caseId: current.id, purpose: "inquiry", fileName: "Private Anfrage.x83", xml, readOnly: true }));
    const fileId = await business.files.upload({ projectId, name: "Privater Positionsbestand.x86", mime: "application/vnd.gaeb+xml",
      blob: new Blob([gaebWorkflowXml("86").replaceAll("Fensterlaibung", "Dateiindexprivatlaibung")], { type: "application/vnd.gaeb+xml" }) });
    const observed: Client = { ...client, query: (async (path, input, options) => {
      requests.push({ path, input });
      if (path === "gaeb.positions.search") throw new Error("Plaintext index access is forbidden");
      if (path === "zerotrust.keys.get") {
        const domain = (input as { domain: string }).domain; keys.push(domain);
        assert.ok(!/:(?:offer-prices|contract-quantities|measurement|calculation|procurement|billing)$/.test(domain), "Text search must never open private amount or quantity keys");
      }
      return client.query(path, input, options);
    }) as Client["query"], mutate: ((path, input, options) => { requests.push({ path, input }); return client.mutate(path, input, options); }) as Client["mutate"] };
    search = createBusinessClient(observed, { productDriver: driver, gaebProcessor: processor });
    async function find(query: string, found: (items: Awaited<ReturnType<typeof searchQuery>>["items"]) => boolean) {
      for (let step = 0; step < 1000; step++) { const page = await searchQuery(query); if (found(page.items) || !page.indexing) return page; }
      throw new Error("Position index did not finish its bounded fixture inventory");
    }
    const searchQuery = (query: string) => required(search!.query("gaeb.positions.search", { query }));
    const suggestions = await find("indexprivatlaib", items => items.some(item => item.shortText === "Indexprivatlaibung"));
    assert.ok(suggestions.items.some(item => item.shortText === "Indexprivatlaibung"));
    const project = await find("dateiindexprivat", items => items.some(item => item.sourceFile === "Privater Positionsbestand.x86"));
    assert.ok(project.items.some(item => item.sourceFile === "Privater Positionsbestand.x86" && item.description.includes("verputzen")));
    assert.ok(!JSON.stringify(suggestions).includes("592.000"));
    await required(search.mutate("projects.files.rename", { projectId, fileId, fileName: "Umbenannter privater Positionsbestand.x86" }));
    assert.ok((await find("dateiindexprivat", items => items.some(item => item.sourceFile === "Umbenannter privater Positionsbestand.x86"))).items.some(item => item.sourceFile === "Umbenannter privater Positionsbestand.x86"));
    await required(business.mutate("commercial.documents.create", { caseId: current.id, purpose: "inquiry", fileName: "Geänderte private Anfrage.x83",
      xml: xml.replaceAll("Indexprivatlaibung", "Aktualisierteprivatlaibung"), readOnly: true, replaceDocumentId: doc.id, expectedVersion: 1n }));
    await search.invalidate("gaeb.positions.search");
    const newer = await find("aktualisierteprivat", items => items.some(item => item.shortText === "Aktualisierteprivatlaibung"));
    assert.ok(newer.items.some(item => item.shortText === "Aktualisierteprivatlaibung"));
    assert.ok(!newer.items.some(item => item.sourceFile === "Private Anfrage.x83"));
    await required(business.mutate("projects.files.delete", { projectId, fileId }));
    await search.invalidate("gaeb.positions.search");
    const removed = await find("dateiindexprivat", () => false);
    assert.ok(!removed.items.some(item => item.sourceFile === "Umbenannter privater Positionsbestand.x86"));
    assert.ok(keys.some(key => key.endsWith(":scope")));
    for (const secret of ["indexprivatlaib", "dateiindexprivat", "aktualisierteprivat", "Private Anfrage", "<GAEB", "592.000"]) assert.ok(!JSON.stringify(requests).includes(secret), secret);
    console.log("Private positions verified: current commercial and project sources, local description-prefix search, scope-only document reads without private quantity/price keys, revisions and deletion, and no plaintext search RPCs.");
  } finally { search?.dispose(); business.dispose(); }
}

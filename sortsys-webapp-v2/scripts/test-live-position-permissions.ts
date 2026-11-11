import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { acceptVault, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeCommercialAccess } from "../app/lib/crypto/permissions";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";
import { gaebTestProcessor } from "./test-live-gaeb";
import { gaebWorkflowXml } from "./test-live-gaeb-workflows";

/** Run before low-level area-admission tests deliberately create non-business
 * payloads. This exercise uses an ordinary certified reader and real documents. */
export async function testPositionPermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const memberId = (await required(memberClient.query("auth.sessionInfo", undefined))).user.id, subject = `user:${memberId}`;
  const ownerBusiness = createBusinessClient(ownerClient, { productDriver: driver, gaebProcessor: gaebTestProcessor });
  let id: string, document: string;
  let stage = "owner case and source creation";
  const requests: { path: string; input: unknown }[] = [], keys: string[] = [];
  const observed: Client = { ...memberClient, query: ((path, input, options) => {
    requests.push({ path, input }); if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain);
    assert.notEqual(path, "gaeb.positions.search");
    return memberClient.query(path, input, options);
  }) as Client["query"] };
  async function search(query: string) {
    await acceptVault(member.exportKey, member.vault, false);
    const business = createBusinessClient(observed, { productDriver: driver, gaebProcessor: gaebTestProcessor });
    try { return await required(business.query("gaeb.positions.search", { query })); }
    finally { business.dispose(); await acceptVault(owner.exportKey, owner.vault, false); }
  }
  try {
    id = (await required(ownerBusiness.mutate("commercial.cases.create", { kind: "offer", title: "Positionsfreigabe Mitarbeiter", scopeItemIds: [] }))).id;
    document = (await required(ownerBusiness.mutate("commercial.documents.create", { caseId: id, purpose: "inquiry", fileName: "Freigegebene Positionstexte.x83",
      xml: gaebWorkflowXml("83").replaceAll("Fensterlaibung", "Mitarbeiterpositionsfreigabe"), readOnly: true }))).id;
    await required(ownerBusiness.mutate("commercial.documents.create", { caseId: id, purpose: "offer", fileName: "Bepreiste Positionen.x84",
      xml: gaebWorkflowXml("84"), netAmount: "1776.00", sourceDocumentId: document, sourceVersion: 1n, readOnly: false }));
    const hidden = await required(ownerBusiness.mutate("commercial.cases.create", { kind: "offer", title: "Nicht freigegebener Positionsbestand", scopeItemIds: [] }));
    await required(ownerBusiness.mutate("commercial.documents.create", { caseId: hidden.id, purpose: "inquiry", fileName: "Nicht freigegebene Positionstexte.x83",
      xml: gaebWorkflowXml("83").replaceAll("Fensterlaibung", "Mitarbeiterpositionsfreigabe VERDECKT"), readOnly: true }));
    stage = "master-only grant and empty member search";
    await changeCommercialAccess(ownerClient, subject, id, "master-data", "read", signal);
    assert.deepEqual(await search("Mitarbeiterpositionsfreigabe"), { items: [], indexing: false });
    stage = "scope grant and ordinary member source read";
    await changeCommercialAccess(ownerClient, subject, id, "scope", "read", signal);
    const readable = await search("Mitarbeiterpositionsfreigabe");
    assert.equal(readable.items.length, 1); assert.equal(readable.items[0]!.shortText, "Mitarbeiterpositionsfreigabe");
    assert.ok(readable.items[0]!.description.includes("verputzen")); assert.equal(readable.indexing, false);
    stage = "trade source creation and independent scope grant";
    const project = await required(ownerBusiness.mutate("projects.create", { title: "Projekt für die Händlerfreigabe" }));
    const trade = await required(ownerBusiness.mutate("commercial.cases.create", { kind: "procurement", title: "Händlerpositionen für Mitarbeitende", projectId: project.id, scopeItemIds: [] }));
    await required(ownerBusiness.mutate("commercial.documents.create", { caseId: trade.id, purpose: "price_inquiry", fileName: "Händlerpositionen.x93",
      xml: gaebWorkflowXml("93").replaceAll("Fensterlaibung", "Mitarbeiterhandelspositionsfreigabe"), readOnly: false }));
    await changeCommercialAccess(ownerClient, subject, trade.id, "master-data", "read", signal);
    await changeCommercialAccess(ownerClient, subject, trade.id, "scope", "read", signal);
    const tradeText = await search("Mitarbeiterhandelspositionsfreigabe");
    assert.equal(tradeText.items.length, 1); assert.equal(tradeText.items[0]!.shortText, "Mitarbeiterhandelspositionsfreigabe");
    assert.ok(keys.some(key => key === commercialCollection(id, "scope").domain));
    assert.ok(!keys.some(key => /:(?:offer-prices|contract-quantities|measurement|calculation|procurement|billing)$/.test(key)));
    stage = "scope revocation and independent price grant";
    await changeCommercialAccess(ownerClient, subject, id, "scope", "none", signal);
    await changeCommercialAccess(ownerClient, subject, id, "offer-prices", "read", signal);
    assert.deepEqual(await search("Mitarbeiterpositionsfreigabe"), { items: [], indexing: false });
    stage = "source revision while scope is revoked";
    await required(ownerBusiness.mutate("commercial.documents.create", { caseId: id, purpose: "inquiry", fileName: "Überarbeitete Positionstexte.x83",
      xml: gaebWorkflowXml("83").replaceAll("Fensterlaibung", "Erneutpositionsfreigegeben"), readOnly: true, replaceDocumentId: document, expectedVersion: 1n }));
    const scopeGeneration = (await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" })))
      .find(domain => domain.id === commercialCollection(id, "scope").domain)!.generation;
    await acceptVault(member.exportKey, member.vault, false);
    try {
      assert.ok((await memberClient.query("zerotrust.keys.get", { domain: commercialCollection(id, "scope").domain, generation: scopeGeneration }, { strategy: "network-only" }))[1]);
      assert.ok((await memberClient.query("zerotrust.keys.get", { domain: commercialCollection(id, "offer-prices").domain, generation: "1" }, { strategy: "network-only" }))[0]);
    } finally { await acceptVault(owner.exportKey, owner.vault, false); }
    stage = "historical scope regrant and latest member search";
    await changeCommercialAccess(ownerClient, subject, id, "scope", "read", signal);
    const restored = await search("Erneutpositionsfreigegeben");
    assert.equal(restored.items.length, 1); assert.equal(restored.items[0]!.shortText, "Erneutpositionsfreigegeben");
    assert.deepEqual((await search("Mitarbeiterpositionsfreigabe")).items, []);
    assert.ok(!keys.some(key => /:(?:offer-prices|contract-quantities|measurement|calculation|procurement|billing)$/.test(key)));
    for (const secret of ["Mitarbeiterpositionsfreigabe", "Erneutpositionsfreigegeben", "Freigegebene Positionstexte", "<GAEB"]) assert.ok(!JSON.stringify(requests).includes(secret));
    console.log("Ordinary member position search verified: master-only exclusion, scope text access without quantity/price keys, scope revocation despite price access, revised sources after historical regrant and no plaintext search requests.");
  } catch (cause) { throw new Error(`Position permission test failed at ${stage}`, { cause }); }
  finally { ownerBusiness.dispose(); }
}

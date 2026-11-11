import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import type { GaebPhase, GaebXmlProcessor } from "@sortsys/gaeb";
import { documentHeadHash } from "@sortsys/zerotrust";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import type { DuckDriver } from "../app/lib/data/database";
import { openProjectCommercial } from "../app/lib/data/projectCommercial";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { gaebWorkflowXml as xml } from "./test-live-gaeb-workflows";
import { until } from "./test-live-events";

export async function testCommercialWorkflows(client: Client, driver: () => Promise<DuckDriver>, processor: GaebXmlProcessor, customerId: string, password: string) {
  const signal = new AbortController().signal, owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "workflow-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVault(owner.exportKey, owner.vault, false);
  const requests: { path: string; input: unknown }[] = []; let lose = false, falseAck = false, race: (() => Promise<void>) | null = null;
  const observed: Client = { ...client, query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      if (path === "zerotrust.objects.batch") {
        if (falseAck) { falseAck = false; return [{ success: true, heads: (input as MutateInput<"zerotrust.objects.batch">).heads }, null]; }
        if (race) { const next = race; race = null; await next(); }
        const result = await client.mutate(path, input, options);
        if (lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost workflow acknowledgement")]; } return result;
      }
      return client.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver, gaebProcessor: processor }), other = createBusinessClient(peer, { productDriver: driver, gaebProcessor: processor });
  const transition = (id: string, expectedStatus: string, status: string, extra = {}) => required(business.mutate("commercial.cases.transition", { id, expectedStatus, status, ...extra }));
  const create = (kind: string, title: string, extra = {}) => required(business.mutate("commercial.cases.create", { kind, title, scopeItemIds: [], ...extra }));
  const document = (caseId: string, purpose: string, phase: GaebPhase, extra = {}) => required(business.mutate("commercial.documents.create", { caseId, purpose, fileName: `Ablauf.x${phase}`, xml: xml(phase), readOnly: false, ...extra }));
  const detail = (id: string) => required(business.query("commercial.cases.get", { id }));
  const change = (id: string, expectedStatus: string, status: string, extra = {}) => business.mutate("commercial.cases.transition", { id, expectedStatus, status, ...extra });
  let stage = "required documents and customer";
  try {
    const main = await create("offer", "Geschützter Angebotsablauf"), inquiry = await document(main.id, "inquiry", "83", { readOnly: true });
    assert.ok((await change(main.id, "draft", "sent"))[1]);
    const bid = await document(main.id, "offer", "84", { netAmount: "1776.00", sourceDocumentId: inquiry.id, sourceVersion: 1n });
    assert.ok((await change(main.id, "draft", "sent"))[1], "A checked offer still needs its customer");
    await required(business.mutate("commercial.cases.update", { id: main.id, title: "Geschützter Angebotsablauf", customerId, counterpartyName: null, validUntil: null, notes: null }));
    await transition(main.id, "draft", "sent");
    assert.equal((await required(business.query("commercial.documents.get", { caseId: main.id, id: bid.id }))).canEdit, false);
    const area = commercialCollection(main.id, "master-data"), receipts = await protectedCollection(observed, area, signal);
    let firstHash: string;
    try {
      const saved = await receipts.read(`${area.prefix}receipt:`); assert.equal(saved.length, 1);
      const receipt = saved[0]!.value as { status: string; documents: { id: string; version: string; hash: string }[] };
      assert.equal(receipt.status, "sent"); const entry = receipt.documents.find(document => document.id === bid.id)!; assert.equal(entry.version, "1"); firstHash = entry.hash;
    } finally { receipts.close(); }
    stage = "revision snapshots and stale calculation source";
    await transition(main.id, "sent", "draft");
    await required(business.mutate("commercial.documents.save", { caseId: main.id, id: bid.id, version: 1n, xml: `${xml("84")}\n` }));
    const store = await commercialDocumentStore(observed, `commercial:${main.id}`, signal);
    try {
      const original = await store.head(bid.id, "1"); assert.ok(original); assert.equal(await documentHeadHash(original), firstHash!);
      assert.equal((await store.load(original, processor)).xml, xml("84"));
      assert.equal(await store.head(bid.id, "999999"), null);
      assert.ok((await observed.query("zerotrust.documents.get", { id: bid.id, scope: "commercial:1", version: "1" }))[1]);
    } finally { store.close(); }
    await document(main.id, "inquiry", "83", { readOnly: true, replaceDocumentId: inquiry.id, expectedVersion: 1n });
    assert.ok((await change(main.id, "draft", "sent"))[1], "The old source version cannot be submitted");
    await document(main.id, "offer", "84", { netAmount: "1776.00", sourceDocumentId: inquiry.id, sourceVersion: 2n, replaceDocumentId: bid.id, expectedVersion: 2n });
    lose = true; await transition(main.id, "draft", "sent"); assert.equal(lose, false);
    falseAck = true; assert.ok((await change(main.id, "sent", "accepted"))[1]); assert.equal((await detail(main.id)).case.status, "sent");
    lose = true; await transition(main.id, "sent", "accepted"); assert.equal(lose, false);
    assert.ok((await change(main.id, "draft", "accepted"))[1]);
    stage = "atomic project creation, local subscription and idempotent retry";
    const titles: string[][] = [], subscription = business.streamQuery("projects.list", { search: "Geschützter Angebotsablauf" }).subscribe(([rows, error]) => { if (!error && rows) titles.push(rows.map(row => row.title)); });
    let projectId: string;
    try {
      lose = true; const project = await required(business.mutate("commercial.cases.createProject", { id: main.id })); projectId = project.id;
      assert.equal(lose, false); await until(() => titles.at(-1)?.includes("Geschützter Angebotsablauf") ?? false, "project list after atomic contract adoption");
      assert.equal((await detail(main.id)).case.projectId, projectId);
      const root = await required(business.query("projects.get", { id: projectId })), customer = await required(business.query("customers.get", { id: customerId }));
      assert.equal(root.customerId, customerId); assert.deepEqual(root.address, customer.address); assert.ok(root.orderReceivedAt);
      const count = (await required(observed.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length;
      assert.deepEqual(await required(business.mutate("commercial.cases.createProject", { id: main.id })), project);
      assert.equal((await required(observed.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length, count);
      const register = await openProjectCommercial(observed, projectId, "offer-prices", signal);
      try { assert.equal(register.value.offers.filter(entry => entry.exactAmount === "1776.00").length, 1); } finally { register.close(); }
    } finally { subscription.unsubscribe(); }
    stage = "concurrent project creation leaves one visible project";
    const raced = await create("offer", "Gleichzeitige Projektübernahme", { customerId }); await document(raced.id, "offer", "84", { netAmount: "1776.00" });
    await transition(raced.id, "draft", "sent"); await transition(raced.id, "sent", "accepted");
    let winner: string | null = null;
    race = async () => { winner = (await required(other.mutate("commercial.cases.createProject", { id: raced.id }))).id; };
    assert.ok((await business.mutate("commercial.cases.createProject", { id: raced.id }))[1]); assert.ok(winner); assert.equal(race, null);
    await business.invalidate("commercial.cases.get"); await business.invalidate("projects.list");
    assert.equal((await detail(raced.id)).case.projectId, winner);
    assert.equal((await required(business.query("projects.list", { search: "Gleichzeitige Projektübernahme" }))).length, 1);
    stage = "accepted alternative links its parent to the same project";
    const parent = await create("offer", "Grundangebot ohne Projekt", { customerId });
    const alternative = await create("alternative", "Angenommene Alternative", { parentCaseId: parent.id, customerId });
    await document(alternative.id, "alternative", "85", { netAmount: "1776.00" }); await transition(alternative.id, "draft", "sent"); await transition(alternative.id, "sent", "accepted");
    const alternateProject = await required(business.mutate("commercial.cases.createProject", { id: alternative.id }));
    assert.equal((await detail(alternative.id)).case.projectId, alternateProject.id); assert.equal((await detail(parent.id)).case.projectId, alternateProject.id);
    stage = "variation acceptance and completed-project race roll back together";
    const variation = await create("variation", "Zusätzliche geschützte Leistung", { projectId: projectId!, parentCaseId: main.id });
    await document(variation.id, "offer", "84", { netAmount: "1776.00" }); await transition(variation.id, "draft", "sent");
    race = async () => { await required(other.mutate("projects.finish", { id: projectId! })); };
    assert.ok((await change(variation.id, "sent", "accepted"))[1]); assert.equal(race, null); assert.equal((await detail(variation.id)).case.status, "sent");
    const unchanged = await openProjectCommercial(observed, projectId!, "offer-prices", signal);
    try { assert.equal(unchanged.value.offers.length, 1); } finally { unchanged.close(); }
    await required(other.mutate("projects.resume", { id: projectId! })); lose = true; await transition(variation.id, "sent", "accepted"); assert.equal(lose, false);
    const offers = await openProjectCommercial(observed, projectId!, "offer-prices", signal);
    try { assert.equal(offers.value.offers.length, 2); } finally { offers.close(); }
    stage = "measurement and calculation lifecycle";
    const measurement = await create("measurement", "Geschütztes Aufmaß im Ablauf", { projectId: projectId!, parentCaseId: main.id, scopeItemIds: ["item-1"] });
    assert.ok((await change(measurement.id, "draft", "submitted"))[1]);
    const takeoff = await document(measurement.id, "measurement", "31", { sourceDocumentId: bid.id, sourceVersion: 3n });
    await transition(measurement.id, "draft", "submitted"); assert.equal((await required(business.query("commercial.documents.get", { caseId: measurement.id, id: takeoff.id }))).canEdit, false);
    await transition(measurement.id, "submitted", "draft"); assert.equal((await required(business.query("commercial.documents.get", { caseId: measurement.id, id: takeoff.id }))).canEdit, true);
    await transition(measurement.id, "draft", "submitted"); await transition(measurement.id, "submitted", "approved"); assert.ok((await change(measurement.id, "approved", "draft"))[1]);
    const calculation = await create("calculation", "Geschützte Kalkulation im Ablauf", { projectId: projectId!, parentCaseId: main.id });
    await document(calculation.id, "calculation", "52"); await transition(calculation.id, "draft", "approved");
    stage = "supplier procurement lifecycle";
    const procurement = await create("procurement", "Geschützte Materialanfrage", { projectId: projectId! });
    const ask = await document(procurement.id, "price_inquiry", "93"); await transition(procurement.id, "draft", "requested");
    const quote = await document(procurement.id, "supplier_offer", "94", { readOnly: true, partnerName: "Geschützter Baustoffhandel", netAmount: "1776.00", sourceDocumentId: ask.id, sourceVersion: 1n });
    assert.ok((await change(procurement.id, "requested", "awarded", { selectedOfferDocumentId: quote.id }))[1]);
    const purchase = await document(procurement.id, "purchase_order", "96", { sourceDocumentId: quote.id, sourceVersion: 1n });
    await transition(procurement.id, "requested", "awarded", { selectedOfferDocumentId: quote.id });
    assert.equal((await detail(procurement.id)).case.counterpartyName, "Geschützter Baustoffhandel"); assert.equal((await detail(procurement.id)).case.netAmount, "1776.00");
    assert.ok((await change(procurement.id, "awarded", "confirmed"))[1]);
    await document(procurement.id, "supplier_confirmation", "97", { readOnly: true, sourceDocumentId: purchase.id, sourceVersion: 1n }); await transition(procurement.id, "awarded", "confirmed");
    stage = "competing subcontract awards across API replicas";
    async function subcontract(title: string, parentCaseId: string) {
      const pack = await create("subcontract", title, { projectId: projectId!, parentCaseId, scopeItemIds: ["item-1"] });
      const ask = await document(pack.id, "inquiry", "83"); await transition(pack.id, "draft", "requested");
      const quote = await document(pack.id, "offer", "84", { readOnly: true, partnerName: "Geschützter Nachunternehmer", netAmount: "1776.00", sourceDocumentId: ask.id, sourceVersion: 1n });
      const order = await document(pack.id, "order", "86", { sourceDocumentId: quote.id, sourceVersion: 1n });
      return { id: pack.id, quote: quote.id, order: order.id };
    }
    const first = await subcontract("Erste parallele Weitervergabe", main.id), second = await subcontract("Zweite parallele Weitervergabe", main.id);
    race = async () => { await required(other.mutate("commercial.cases.transition", { id: second.id, expectedStatus: "requested", status: "awarded", selectedOfferDocumentId: second.quote, awardedItemIds: ["item-1"] })); };
    assert.ok((await change(first.id, "requested", "awarded", { selectedOfferDocumentId: first.quote }))[1]); assert.equal(race, null);
    assert.equal((await detail(first.id)).case.status, "requested"); assert.ok((await change(first.id, "requested", "awarded", { selectedOfferDocumentId: first.quote }))[1]);
    await document(second.id, "confirmation", "87", { sourceDocumentId: second.order, sourceVersion: 1n }); await transition(second.id, "awarded", "confirmed");
    const third = await subcontract("Weitervergabe im Nachtrag", variation.id); await transition(third.id, "requested", "awarded", { selectedOfferDocumentId: third.quote });
    const awards = await openProjectCommercial(observed, projectId!, "procurement", signal);
    try { assert.equal(awards.value.awards.length, 2); } finally { awards.close(); }
    for (const canary of ["Geschützter Angebotsablauf", "Gleichzeitige Projektübernahme", "Geschützter Baustoffhandel", "Geschützter Nachunternehmer", "<GAEB"]) assert.equal(JSON.stringify(requests).includes(canary), false, canary);
    console.log("Protected commercial lifecycles verified: customer/document/source checks, immutable historical XML references, revisions, rollback after false acknowledgements, atomic/idempotent/concurrent project creation, alternative parent linking, exact project offer values, finished-project races, measurement/calculation, supplier procurement and competing subcontract awards across API replicas without plaintext requests.");
  } catch (cause) { throw new Error(`Protected commercial lifecycle failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
}

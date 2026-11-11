import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import type { GaebXmlProcessor } from "@sortsys/gaeb";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import type { GaebPhase } from "../../sortsys-gaeb/src/core/types";
import { documentHeadHash, documentMicros, signDocumentHead } from "@sortsys/zerotrust";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import { parseCommercialDocumentUrl } from "../app/lib/data/commercialDocumentUrl";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { publicId, readBusinessRows } from "../app/lib/data/products";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";

const TITLE = "Geschütztes neues Angebot";
function native(phase: GaebPhase, id = "item-1") {
  const description = '<Description><CompleteText><DetailTxt><Text><p><span>Fensterlaibung verputzen.</span></p></Text></DetailTxt><OutlineText><OutlTxt><TextOutlTxt><p><span>Fensterlaibung</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>';
  const xml = createGaebXml(phase, TITLE, "2026-11-10");
  if (["93", "94", "96", "97"].includes(phase)) return xml.replace("</Order>", `<OrderItem ID="${id}"><ArtNo>TEST-1</ArtNo><Qty>3.00</Qty><QU>m²</QU>${description}${phase === "93" ? "" : "<NetPrice>592.00</NetPrice><PriceBasis>1.00</PriceBasis>"}<OrderPosNo>1</OrderPosNo></OrderItem></Order>`);
  const fields = phase === "31" ? "<QtyDeterm><Qty>3.000</Qty></QtyDeterm>" : `<Qty>3.000</Qty>${phase === "84" ? "" : "<QU>m²</QU>"}${phase === "83" ? "" : "<UP>592.000</UP><IT>1776.00</IT>"}${phase === "84" ? "" : description}`;
  return xml.replace("<BoQBody/>", `<BoQBody><Itemlist><Item ID="${id}" RNoPart="0001">${fields}</Item></Itemlist></BoQBody>`);
}
export { native as gaebWorkflowXml };

export async function testGaebDocumentWorkflows(client: Client, source: BusinessDatabase, driver: () => Promise<DuckDriver>, processor: GaebXmlProcessor, password: string) {
  const signal = new AbortController().signal, owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "gaeb-workflow-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVault(owner.exportKey, owner.vault, false);
  const requests: { path: string; input: unknown }[] = []; let lose = false, raceSource: { caseId: string; id: string } | null = null;
  const observed: Client = { ...client,
    query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      const publishing = path === "zerotrust.objects.batch" && !!(input as MutateInput<"zerotrust.objects.batch">).documents?.length;
      if (publishing && raceSource) {
        const target = raceSource; raceSource = null;
        const current = await required(other.query("commercial.documents.get", target));
        await required(other.mutate("commercial.documents.create", { caseId: target.caseId, purpose: "inquiry", replaceDocumentId: target.id,
          expectedVersion: current.version, fileName: "Anfrage aktualisiert.x83", readOnly: true, xml: `${current.xml}\n` }));
      }
      const result = await client.mutate(path, input, options);
      if (publishing && lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost workflow acknowledgement")]; }
      return result;
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver, gaebProcessor: processor }), other = createBusinessClient(peer, { productDriver: driver, gaebProcessor: processor });
  const documents = await readBusinessRows(source, "commercial_documents"), cases = await readBusinessRows(source, "commercial_cases"), projects = await readBusinessRows(source, "projects");
  const openProjects = new Set(projects.filter(row => row.values.finished_at === null).map(row => row.values.id));
  let stage = "new inquiry";
  try {
    for (const phase of ["83", "84", "85", "86", "87", "31", "52", "93", "94", "96", "97"] as const) {
      const xml = native(phase), split = await processor.partition(xml, "offer", signal);
      assert.equal((await processor.validate(xml, split.layout.identity, signal)).valid, true, `Fixture X${phase} must pass its official XSD`);
    }
    const main = await required(business.mutate("commercial.cases.create", { kind: "offer", title: TITLE, scopeItemIds: [] }));
    const inquiry = await required(business.mutate("commercial.documents.create", { caseId: main.id, purpose: "inquiry", readOnly: false, fileName: "Anfrage.x83", xml: native("83") }));
    stage = "read-only source revision and native unseal rejection";
    await required(business.mutate("commercial.documents.create", { caseId: main.id, purpose: "inquiry", replaceDocumentId: inquiry.id,
      expectedVersion: 1n, readOnly: true, fileName: "Anfrage empfangen.x83", xml: native("83") }));
    const scope = await required(business.query("commercial.documents.get", { caseId: main.id, id: inquiry.id }));
    assert.equal(scope.xml, native("83"));
    assert.equal(scope.version, 2n); assert.equal(scope.canEdit, false);
    assert.ok((await business.mutate("commercial.documents.save", { caseId: main.id, id: inquiry.id, version: scope.version, xml: `${scope.xml}\n` }))[1]);
    assert.ok((await business.mutate("commercial.documents.create", { caseId: main.id, purpose: "inquiry", replaceDocumentId: inquiry.id,
      expectedVersion: scope.version, readOnly: false, fileName: "Anfrage entsperrt.x83", xml: native("83") }))[1]);
    const received = await commercialDocumentStore(observed, `commercial:${main.id}`, signal);
    try {
      const head = (await received.head(inquiry.id))!; assert.equal(head.readOnly, true); assert.equal(head.locked, false);
      const unsealed = await signDocumentHead({ ...head, readOnly: false, version: (BigInt(head.version) + 1n).toString(), previous: await documentHeadHash(head),
        modifiedMicros: documentMicros(new Date().toISOString()) }, unlockedAccount()!.identity.signingKey.privateKey);
      assert.ok((await observed.mutate("zerotrust.objects.batch", { objects: [], documents: [unsealed], heads: [] }))[1], "Even an administrator cannot unseal a received document");
    } finally { received.close(); }
    const bidInput = { caseId: main.id, purpose: "offer", readOnly: false, fileName: "Angebot.x84", xml: native("84"), netAmount: null, sourceDocumentId: inquiry.id, sourceVersion: scope.version };
    stage = "cross-instance source edit during publication";
    raceSource = { caseId: main.id, id: inquiry.id };
    assert.ok((await business.mutate("commercial.documents.create", bidInput))[1]); assert.equal(raceSource, null);
    await business.invalidate("commercial.cases.get");
    assert.equal((await required(business.query("commercial.cases.get", { id: main.id }))).documents.length, 1);
    const revised = await required(business.query("commercial.documents.get", { caseId: main.id, id: inquiry.id }));
    assert.equal(revised.version, scope.version + 1n);
    assert.ok((await business.mutate("commercial.documents.create", bidInput))[1], "A stale source cannot be accepted after a retry");
    stage = "bid publication and metadata-only replacement";
    lose = true;
    const bid = await required(business.mutate("commercial.documents.create", { ...bidInput, sourceVersion: revised.version })); assert.equal(lose, false);
    assert.ok((await business.mutate("commercial.documents.create", { ...bidInput, sourceVersion: revised.version }))[1], "A second main bid needs a separate case");
    const store = await commercialDocumentStore(observed, `commercial:${main.id}`, signal);
    try {
      const before = await store.head(bid.id); assert.ok(before);
      await required(business.mutate("commercial.documents.create", { ...bidInput, fileName: "Angebot umbenannt.x84", sourceVersion: revised.version, replaceDocumentId: bid.id, expectedVersion: 1n }));
      const after = await store.head(bid.id); assert.ok(after); assert.equal(after.version, "2"); assert.deepEqual(after.parts, before.parts, "Renaming must not rewrite any XML facet");
      const saved = await required(business.mutate("commercial.documents.save", { caseId: main.id, id: bid.id, version: 2n, xml: native("84"), netAmount: "1776.00" }));
      assert.equal(saved.version, 3n); assert.deepEqual((await store.head(bid.id))!.parts, before.parts, "An amount metadata change must not require scope writes");
    } finally { store.close(); }
    stage = "document-only stale guards and metadata replay";
    const locking = await commercialDocumentStore(observed, `commercial:${main.id}`, signal);
    try {
      const previous = (await locking.head(bid.id))!, proposal = await locking.lock(previous, new Date().toISOString());
      const detail = await required(other.query("commercial.cases.get", { id: main.id }));
      await required(other.mutate("commercial.cases.update", { id: main.id, title: "Parallel geändertes Angebot", customerId: detail.case.customerId, counterpartyName: detail.case.counterpartyName, validUntil: detail.case.validUntil, notes: detail.case.notes }));
      await assert.rejects(() => locking.publish(proposal), "A stale guard must reject a document-only commit");
      assert.equal((await locking.head(bid.id))!.locked, false);
      const noop = await signDocumentHead({ ...previous, version: (BigInt(previous.version) + 1n).toString(), previous: await documentHeadHash(previous), modifiedMicros: documentMicros(new Date().toISOString()) }, unlockedAccount()!.identity.signingKey.privateKey);
      assert.ok((await observed.mutate("zerotrust.objects.batch", { objects: [], documents: [noop], heads: [] }))[1]);
      const area = commercialCollection(main.id, "master-data"), master = await protectedCollection(observed, area, signal);
      try {
        const [existing] = await master.read(`${area.prefix}case`); assert.ok(existing);
        assert.ok((await observed.mutate("zerotrust.objects.batch", { objects: [{ domain: area.domain, messageId: "gaeb-metadata-replay", envelope: existing.envelope }],
          heads: [{ domain: area.domain, sequence: master.snapshot() }], documents: [noop] }))[1], "Replaying unchanged metadata must not authorize a new document revision");
      } finally { master.close(); }
    } finally { locking.close(); }
    stage = "download and invalid authored input";
    const download = await required(business.query("commercial.documents.download", { caseId: main.id, id: bid.id })), resource = parseCommercialDocumentUrl(download.url);
    assert.equal(download.fileName, "Angebot umbenannt.x84"); assert.equal(await (await business.documents.blob(resource.caseId, resource.id, resource.version)).text(), native("84"));
    await assert.rejects(() => business.documents.blob(main.id, bid.id, "1"));
    const writes = () => requests.filter(request => request.path === "zerotrust.objects.batch").length, beforeInvalid = writes();
    assert.ok((await business.mutate("commercial.documents.create", { ...bidInput, replaceDocumentId: bid.id, expectedVersion: 3n, sourceVersion: revised.version, xml: native("84").replace("<GAEBInfo>", "<GAEBInfo><Unexpected/>") }))[1]);
    assert.equal(writes(), beforeInvalid, "Invalid authored XML must fail before staging");
    stage = "alternative offer";
    const alternative = await required(business.mutate("commercial.cases.create", { kind: "alternative", title: "Alternative Fensterlaibung", parentCaseId: main.id, scopeItemIds: [] }));
    await required(business.mutate("commercial.documents.create", { caseId: alternative.id, purpose: "alternative", readOnly: false, fileName: "Nebenangebot.x85", xml: native("85"), netAmount: "1776.00", sourceDocumentId: inquiry.id, sourceVersion: revised.version }));
    stage = "incoming contract for a sent bid";
    const sent = cases.find(row => row.values.kind === "offer" && row.values.status === "sent" && !documents.some(doc => doc.values.case_id === row.values.id && doc.values.purpose === "order")); assert.ok(sent);
    const sentId = publicId(sent.values.id), sentBid = documents.find(doc => doc.values.case_id === sent.values.id && doc.values.phase === "84"); assert.ok(sentBid);
    const sentContent = await required(business.query("commercial.documents.get", { caseId: sentId, id: publicId(sentBid.values.id) }));
    const receivedOrder = await required(business.mutate("commercial.documents.create", { caseId: sentId, purpose: "order", fileName: "Auftrag.x86", xml: native("86"),
      readOnly: true, sourceDocumentId: publicId(sentBid.values.id), sourceVersion: sentContent.version }));
    assert.equal((await required(business.query("commercial.documents.get", { caseId: sentId, id: receivedOrder.id }))).xml, native("86"));
    stage = "confirmation and permanent finalization";
    const accepted = cases.find(row => row.values.kind === "offer" && row.values.status === "accepted" && openProjects.has(row.values.project_id)
      && !documents.some(doc => doc.values.case_id === row.values.id && doc.values.purpose === "confirmation")); assert.ok(accepted);
    const contractId = publicId(accepted.values.id), projectId = publicId(accepted.values.project_id), acceptedBid = documents.find(row => row.values.case_id === accepted.values.id && row.values.phase === "84"); assert.ok(acceptedBid);
    const acceptedContent = await required(business.query("commercial.documents.get", { caseId: contractId, id: publicId(acceptedBid.values.id) }));
    const order = documents.find(doc => doc.values.case_id === accepted.values.id && doc.values.purpose === "order"); assert.ok(order);
    const orderContent = await required(business.query("commercial.documents.get", { caseId: contractId, id: publicId(order.values.id) }));
    const confirmation = await required(business.mutate("commercial.documents.create", { caseId: contractId, purpose: "confirmation", readOnly: false, fileName: "Bestätigung.x87", xml: native("87"), sourceDocumentId: publicId(order.values.id), sourceVersion: orderContent.version }));
    const final = await required(business.mutate("commercial.documents.finalize", { caseId: contractId, id: confirmation.id, version: 1n }));
    assert.equal(final.version, 2n); assert.equal((await required(business.query("commercial.documents.get", { caseId: contractId, id: confirmation.id }))).canEdit, false);
    for (const readOnly of [false, true]) assert.ok((await business.mutate("commercial.documents.create", { caseId: contractId, purpose: "confirmation", readOnly, fileName: "Unzulässig.x87", xml: native("87"), replaceDocumentId: confirmation.id, expectedVersion: 2n }))[1]);
    stage = "measurement and calculation";
    const sourceItem = /<Item\b[^>]*\bID="([^"]+)"/.exec(acceptedContent.xml)?.[1]; assert.ok(sourceItem);
    for (const [kind, purpose, phase] of [["measurement", "measurement", "31"], ["calculation", "calculation", "52"]] as const) {
      const created: { id: string } = await required(business.mutate("commercial.cases.create", { kind, title: `Neu ${kind}`, projectId, parentCaseId: contractId, scopeItemIds: [sourceItem] }));
      const item: { id: string } = await required(business.mutate("commercial.documents.create", { caseId: created.id, purpose, readOnly: false, fileName: `Neu.x${phase}`, xml: native(phase, sourceItem), sourceDocumentId: publicId(acceptedBid.values.id), sourceVersion: acceptedContent.version }));
      assert.equal((await required(business.query("commercial.documents.get", { caseId: created.id, id: item.id }))).xml, native(phase, sourceItem));
    }
    for (const [status, phase, purpose, sourcePhase] of [["draft", "93", "price_inquiry", null], ["requested", "94", "supplier_offer", "93"], ["requested", "96", "purchase_order", "94"], ["awarded", "97", "supplier_confirmation", "96"]] as const) {
      stage = `supplier phase ${phase}`;
      const target = cases.find(row => row.values.kind === "procurement" && row.values.status === status); assert.ok(target);
      const caseId = publicId(target.values.id), reference = sourcePhase ? documents.find(row => row.values.case_id === target.values.id && row.values.phase === sourcePhase) : null;
      if (sourcePhase) assert.ok(reference);
      const version = reference ? (await required(business.query("commercial.documents.get", { caseId, id: publicId(reference.values.id) }))).version : null;
      const existing = purpose === "supplier_offer" ? undefined : documents.find(doc => doc.values.case_id === target.values.id && doc.values.purpose === purpose);
      const previous = existing ? await required(business.query("commercial.documents.get", { caseId, id: publicId(existing.values.id) })) : null;
      const input = { caseId, purpose, fileName: `Lieferant.x${phase}`, xml: native(phase), readOnly: ["supplier_offer", "supplier_confirmation"].includes(purpose), partnerName: "Lieferant Sicherheitstest",
        ...(reference ? { sourceDocumentId: publicId(reference.values.id), sourceVersion: version! } : {}), ...(existing ? { replaceDocumentId: publicId(existing.values.id), expectedVersion: previous!.version } : {}) };
      if (purpose === "supplier_offer") assert.ok((await business.mutate("commercial.documents.create", { ...input, readOnly: false }))[1]);
      const item: { id: string } = await required(business.mutate("commercial.documents.create", input));
      assert.equal((await required(business.query("commercial.documents.get", { caseId, id: item.id }))).xml, native(phase));
    }
    for (const secret of [TITLE, "Fensterlaibung verputzen.", "Angebot umbenannt.x84", "Lieferant Sicherheitstest", "1776.00", "<GAEB", "<OrderItem"]) assert.equal(JSON.stringify(requests).includes(secret), false, secret);
    console.log("Private document workflows verified: authored XSD checks, new/replaced inquiry and bid, source races across API replicas, lost acknowledgement, metadata-only revisions, stale document-only guards, replay denial, private version-bound downloads, alternative, award/confirmation/finalization, measurement/calculation and supplier phases.");
  } catch (cause) { throw new Error(`Protected GAEB document workflow failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
}

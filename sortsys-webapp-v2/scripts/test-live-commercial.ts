import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { joinCommercialFacets } from "../app/lib/data/commercialData";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareCommercialCases } from "../app/lib/data/migrateCommercial";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { until } from "./test-live-events";

export async function testProtectedCommercial(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, baseline: QueryResult<"commercial.cases.get">, customerId: string, password: string) {
  const signal = new AbortController().signal;
  await prepareCommercialCases(client, source, subject, signal);
  await prepareCommercialCases(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "commercial-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVault(owner.exportKey, owner.vault, false);
  const requests: unknown[] = []; let lose = false, falseAck = false, raceCustomer = false;
  const observed: Client = { ...client, query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      if (path === "zerotrust.objects.batch") {
        if (falseAck) { falseAck = false; return [{ success: true, heads: (input as { heads: unknown }).heads }, null]; }
        if (raceCustomer) { raceCustomer = false; await required(other.mutate("customers.update", { id: customerId, data: { name: "Bauleitung während Angebotsänderung bearbeitet" } })); }
        const result = await client.mutate(path, input, options);
        if (lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost commercial acknowledgement")]; }
        return result;
      }
      return client.mutate(path, input, options);
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver, endpoint: process.env.SORTSYS_LLM_TEST_PEER!, realtime: true });
  let stage = "migrated commercial metadata";
  try {
    const detail = await required(business.query("commercial.cases.get", { id: baseline.case.id }));
    for (const key of ["title", "reference", "kind", "status", "netAmount", "notes", "scopeItemIds", "validUntil", "customerId"] as const) assert.deepEqual(detail.case[key], baseline.case[key], key);
    assert.equal(detail.documents.length, baseline.documents.length);
    assert.equal(detail.documents[0]!.netAmount, "1234567890123.45");
    assert.deepEqual(detail.events.map(event => ({ id: event.id, action: event.action, status: event.status })), baseline.events.map(event => ({ id: event.id, action: event.action, status: event.status })));
    assert.equal(new Date(detail.case.createdAt).getTime(), new Date(baseline.case.createdAt).getTime());
    assert.ok((await required(business.query("commercial.cases.list", { search: "Verschlüsselungstest", limit: 50n, offset: 0n }))).some(value => value.id === baseline.case.id));
    const area = commercialCollection(baseline.case.id, "master-data"), master = await protectedCollection(client, area, signal);
    try {
      const parts = await master.read(`${area.prefix}case`);
      const plain = JSON.stringify(parts[0]!.value);
      assert.equal(plain.includes("1234567890123.45"), false); assert.equal(plain.includes("Vertraulicher Lohnansatz"), false);
      const visible = joinCommercialFacets(baseline.case.id, new Map([["master-data", parts[0]!.value]]));
      assert.equal(visible.find(row => row.table === "commercial_cases")!.values.net_amount, null);
    } finally { master.close(); }
    stage = "validate before provisioning";
    const before = (await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length;
    assert.ok((await business.mutate("commercial.cases.create", { kind: "offer", title: " ", scopeItemIds: [] }))[1]);
    assert.ok((await business.mutate("commercial.cases.create", { kind: "offer", title: "Invalid main offer in project", projectId: "1", scopeItemIds: [] }))[1]);
    assert.ok((await business.mutateDynamic("commercial.cases.create", { kind: "offer", title: "Unknown field", secretAmount: "139.00" }))[1]);
    assert.equal((await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length, before);
    stage = "normal create and local subscription";
    const titles: string[][] = [], subscription = business.streamQuery("commercial.cases.list", { search: "Geschütztes Angebot", limit: 50n }).subscribe(([values, error]) => { if (!error && values) titles.push(values.map(value => value.title)); });
    try {
      lose = true;
      const created = await required(business.mutate("commercial.cases.create", { kind: "offer", title: "Geschütztes Angebot Schulfassade", customerId, scopeItemIds: [] }));
      assert.equal(lose, false);
      await until(() => titles.at(-1)?.includes("Geschütztes Angebot Schulfassade") ?? false, "commercial list local subscription");
      assert.equal((await required(business.query("commercial.cases.get", { id: created.id }))).case.customerId, customerId);
      const remote: QueryResult<"commercial.cases.get">[] = [], updates = other.streamQuery("commercial.cases.get", { id: created.id }).subscribe(([value, error]) => { if (value && !error) remote.push(value); });
      try {
      await until(() => remote.at(-1)?.case.title === "Geschütztes Angebot Schulfassade", "commercial document observer ready on second API");
      const update = { id: created.id, title: "Geschütztes Angebot Schulfassade geändert", customerId, counterpartyName: null, validUntil: "2026-12-24", notes: "Vertrauliche Kalkulationsnotiz 53,71 Euro" };
      await required(business.mutate("commercial.cases.update", update));
      await until(() => remote.at(-1)?.case.title === update.title && remote.at(-1)?.case.notes === update.notes, "commercial header/note websocket synchronization across API replicas");
      let current = await required(business.query("commercial.cases.get", { id: created.id }));
      assert.equal(current.case.notes, update.notes); assert.equal(current.case.validUntil, update.validUntil);
      stage = "atomic split writes and false acknowledgement";
      falseAck = true;
      assert.ok((await business.mutate("commercial.cases.update", { ...update, title: "Unbestätigtes Angebot", notes: "Unbestätigte Notiz" }))[1]);
      current = await required(business.query("commercial.cases.get", { id: created.id }));
      assert.equal(current.case.title, update.title); assert.equal(current.case.notes, update.notes);
      stage = "customer changes on independent API instance";
      raceCustomer = true;
      assert.ok((await business.mutate("commercial.cases.update", { ...update, title: "Angebotsänderung bei veraltetem Kunden", notes: "Notiz bei veraltetem Kunden" }))[1]);
      current = await required(business.query("commercial.cases.get", { id: created.id }));
      assert.equal(current.case.title, update.title); assert.equal(current.case.notes, update.notes);
      lose = true;
      await required(business.mutate("commercial.cases.update", { ...update, title: "Geschütztes Angebot final bearbeitet", notes: "Bestätigte interne Notiz" }));
      assert.equal(lose, false);
      current = await required(other.query("commercial.cases.get", { id: created.id }));
      assert.equal(current.case.title, "Geschütztes Angebot final bearbeitet"); assert.equal(current.case.notes, "Bestätigte interne Notiz");
      assert.ok((await business.mutateDynamic("commercial.cases.update", { ...update, netAmount: "0.01" }))[1]);
      assert.ok((await business.mutate("commercial.documents.save", { caseId: created.id, id: "1", version: 1n, xml: "NO-PLAINTEXT-DOCUMENT-FALLBACK" }))[1]);
      const keys = requests.filter(value => (value as { path: string }).path === "zerotrust.keys.get").length;
      await business.invalidate("commercial.cases.get");
      assert.equal(requests.filter(value => (value as { path: string }).path === "zerotrust.keys.get").length, keys, "Unchanged case heads must reuse verified plaintext without fetching and opening their keys again");
      } finally { updates.unsubscribe(); }
    } finally { subscription.unsubscribe(); }
    for (const canary of ["Geschütztes Angebot", "Vertrauliche Kalkulationsnotiz", "Unbestätigtes Angebot", "Notiz bei veraltetem Kunden", "NO-PLAINTEXT-DOCUMENT-FALLBACK"]) assert.equal(JSON.stringify(requests).includes(canary), false, canary);
  } catch (cause) { throw new Error(`Protected commercial cases failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
  console.log("Protected commercial cases verified: resumable metadata migration, independent private facets, exact amounts, local list/search, ordinary create/update, atomic header/note commits, lost acknowledgements, targeted websocket synchronization, unchanged-head reuse and cross-instance reference conflicts.");
}

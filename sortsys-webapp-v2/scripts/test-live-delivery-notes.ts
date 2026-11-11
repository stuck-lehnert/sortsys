import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { areaKey, base64, bytes, domainBoxSigner, encryptObject, openBox, policy, randomSecret, record, signPolicy, verifyDomain } from "@sortsys/zerotrust";
import { acceptVault, lockCryptoSession, signIn, trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { commitRecovery, recoveryDraft, recoveryPlan } from "../app/lib/crypto/recovery";
import { openAuthority } from "../app/lib/crypto/setup";
import { finishAccessChanges } from "../app/lib/crypto/permissions";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { prepareProductCatalog } from "../app/lib/data/migrateProducts";
import { prepareProjects } from "../app/lib/data/migrateProjects";
import { prepareDeliveryNotes } from "../app/lib/data/migrateDeliveryNotes";
import { deliveryCollection } from "../app/lib/data/deliveryNoteData";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { until } from "./test-live-events";

type Note = QueryResult<"deliveryNotes.get">;
const normalized = (notes: Note[]) => notes.map(({ revision: _revision, priceRevision: _priceRevision, ...note }) => ({ ...note, records: note.records.slice().sort(byId), specialRecords: note.specialRecords.slice().sort(byId) })).sort(byId);
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

export async function testDeliveryNoteRecovery(client: Client, driver: () => Promise<DuckDriver>, phrase: string) {
  const before = createBusinessClient(client, { productDriver: driver });
  let notes: Note[], costs: QueryResult<"deliveryNotes.costs.get">;
  try { notes = await required(before.query("deliveryNotes.list", {})); costs = await required(before.query("deliveryNotes.costs.get", { id: notes[0]!.id })); }
  finally { before.dispose(); }
  const tenant = unlockedAccount()!.tenant, password = "Delivery-Seed-Recovery-Test-2026!";
  await lockCryptoSession(); client.setToken(null);
  assert.equal(unlockedAccount(), null); assert.equal(client.loggedIn(), false);
  const draft = await recoveryDraft(client, tenant, phrase, password), plan = await recoveryPlan(client, draft);
  await commitRecovery(client, plan);
  await signIn(client, { tenant, username: plan.username, password });
  const after = createBusinessClient(client, { productDriver: driver });
  try {
    assert.deepEqual(normalized(await required(after.query("deliveryNotes.list", {}))), normalized(notes));
    assert.deepEqual(await required(after.query("deliveryNotes.costs.get", { id: notes[0]!.id })), costs);
  } finally { after.dispose(); }
  await assert.rejects(() => recoveryDraft(client, tenant, phrase, password));
  console.log("Encrypted delivery quantities and special prices survived recovery without an authenticated session or unlocked account, using only the phrase after access rotations; the consumed phrase was rejected immediately.");
}

export async function testProtectedDeliveryNotes(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, baseline: Note[], costs: Map<string, QueryResult<"deliveryNotes.costs.get">>, password: string) {
  const signal = new AbortController().signal;
  await prepareProductCatalog(client, source, subject, signal);
  await prepareProjects(client, source, subject, signal);
  await prepareDeliveryNotes(client, source, subject, signal); await prepareDeliveryNotes(client, source, subject, signal);
  const account = unlockedAccount()!, peerUrl = process.env.SORTSYS_LLM_TEST_PEER!, peer = createClient(peerUrl, "delivery-note-peer");
  await signIn(peer, { tenant: account.tenant, username: account.username, password });
  await acceptVault(account.exportKey, account.vault, false);
  const requests: { path: string; input: unknown }[] = [];
  let betweenFacets: (() => Promise<void>) | null = null;
  const observed: Client = { ...client,
    query: (async (path, input, options) => {
      requests.push({ path, input }); assert.ok(!path.startsWith("deliveryNotes.") && !path.startsWith("products.") && !path.startsWith("projects."));
      if (betweenFacets && path === "zerotrust.objects.list" && (input as { domain: string }).domain === pricing.domain) {
        const change = betweenFacets; betweenFacets = null; await change();
      }
      return client.query(path, input, options);
    }) as Client["query"],
    mutate: ((path, input, options) => { requests.push({ path, input }); assert.ok(!path.startsWith("deliveryNotes.")); return client.mutate(path, input, options); }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver });
  const selected = baseline.find(note => note.specialRecords.some(row => row.pricePerUnit !== null))!; assert.ok(selected);
  const other = baseline.find(note => note.projectId !== selected.projectId)!; assert.ok(other);
  const area = deliveryCollection(selected.projectId), objectId = area.prefix + selected.id;
  const pricing = deliveryCollection(selected.projectId, true), otherArea = deliveryCollection(other.projectId);
  try {
    assert.deepEqual(normalized(await required(business.query("deliveryNotes.list", {}))), normalized(baseline));
    assert.deepEqual(normalized([await required(business.query("deliveryNotes.get", { autoId: selected.autoId }))]), normalized([selected]));
    for (const note of baseline) {
      const got = await required(business.query("deliveryNotes.costs.get", { id: note.id })), expected = costs.get(note.id)!;
      assert.deepEqual(got.records.slice().sort((a, b) => a.recordId.localeCompare(b.recordId)), expected.records.slice().sort((a, b) => a.recordId.localeCompare(b.recordId)));
      assert.deepEqual(got.specialRecords.slice().sort((a, b) => a.recordId.localeCompare(b.recordId)), expected.specialRecords.slice().sort((a, b) => a.recordId.localeCompare(b.recordId)));
      assert.ok(Math.abs(got.totalCost - expected.totalCost) <= Number.EPSILON * Math.max(1, Math.abs(expected.totalCost)) * (got.records.length + got.specialRecords.length + 1) * 2);
    }
    assert.equal((await required(business.query("deliveryNotes.list", { projectId: selected.projectId }))).every(note => note.projectId === selected.projectId), true);
    assert.ok((await business.queryDynamic("deliveryNotes.list", { projectId: selected.projectId, unexpected: "must not leave browser" }))[1]);
    const changes: string[] = [], remote = createBusinessClient(peer, { endpoint: peerUrl, realtime: true, productDriver: driver });
    const subscription = remote.streamQuery("deliveryNotes.get", { id: selected.id }).subscribe(([note, error]) => { if (note && !error) changes.push(note.comment ?? ""); });
    const collection = await protectedCollection(client, area, signal), marker = "Nur im Browser sichtbarer Lieferschein – 98765,4321";
    try {
      await until(() => changes.length > 0, "initial encrypted delivery-note subscription");
      const original = (await collection.read(objectId)).find(object => object.envelope.object === objectId)!; assert.ok(original);
      const value = structuredClone(original.value) as { note: { values: Record<string, unknown> }; specialRecords: { values: Record<string, unknown> }[] };
      value.note.values.comment = marker;
      const packet = await collection.packet(objectId, value, original.envelope);
      betweenFacets = () => collection.write([packet]);
      const raced = createBusinessClient(observed, { productDriver: driver });
      try {
        assert.equal((await required(raced.query("deliveryNotes.get", { id: selected.id }))).comment, marker,
          "A quantity change between the two facet reads must restart the snapshot rather than publish the stale quantity half");
        assert.equal(betweenFacets, null);
      } finally { raced.dispose(); }
      await until(() => changes.includes(marker), "delivery-note change from the independent API process");
      const last = (await collection.read(objectId)).find(object => object.envelope.object === objectId)!;
      value.specialRecords[0]!.values.price_per_unit = 98765.4321; // A correctly signed dishonest writer, not broken crypto.
      await collection.write([await collection.packet(objectId, value, last.envelope)]);
      const fresh = createBusinessClient(observed, { productDriver: driver });
      try { assert.ok((await fresh.query("deliveryNotes.list", {}))[1], "Malformed private rows must fail the complete list, not disappear silently"); }
      finally { fresh.dispose(); }
      const bad = (await collection.read(objectId)).find(object => object.envelope.object === objectId)!;
      await collection.write([await collection.packet(objectId, original.value, bad.envelope)]);
    } finally { subscription.unsubscribe(); remote.dispose(); collection.close(); }
    assert.equal(JSON.stringify(requests).includes(marker), false); assert.equal(JSON.stringify(requests).includes("98765.4321"), false);

    const history = await trustedHistory(client), status = await required(client.query("zerotrust.status", undefined)), authority = await openAuthority(client, status.profile);
    const signed = record(await required(client.query("zerotrust.policy.get", undefined)), ["tenant", "version", "rules", "signature"]);
    const original = policy({ tenant: signed.tenant, version: signed.version, rules: signed.rules });
    const changed = await signPolicy({ ...original, version: (BigInt(original.version) + 1n).toString(), rules: original.rules
      .filter(rule => rule.subject !== subject || !(rule.scope === pricing.scope && rule.facet === pricing.facet || rule.scope === otherArea.scope && rule.facet === otherArea.facet))
      .map(rule => rule.subject === subject && rule.scope === area.scope && rule.facet === area.facet ? { ...rule, actions: ["read"] } : rule) }, authority);
    await required(client.mutate("zerotrust.policy.replace", changed));
    try {
      const start = requests.length, reader = createBusinessClient(observed, { productDriver: driver });
      try {
        const opened = await required(reader.query("deliveryNotes.get", { id: selected.id }));
        assert.ok(opened.specialRecords.every(row => row.pricePerUnit === null));
        assert.deepEqual(opened.records.slice().sort(byId), selected.records.slice().sort(byId));
        assert.ok((await reader.query("deliveryNotes.costs.get", { id: selected.id }))[1]);
        assert.ok((await reader.query("deliveryNotes.list", { projectId: other.projectId }))[1]);
        assert.equal(requests.slice(start).some(request => ["zerotrust.keys.get", "zerotrust.objects.list"].includes(request.path) &&
          [pricing.domain, otherArea.domain].includes((request.input as { domain?: string })?.domain ?? "")), false);
      } finally { reader.dispose(); }
      const [, denied] = await peer.query("zerotrust.objects.get", { id: otherArea.prefix + other.id }, { strategy: "network-only" });
      assert.ok(denied && "code" in denied); assert.equal(denied.code, "FORBIDDEN");
      // A reader has an identity signing key and the area key. Bypass every
      // facade/packet guard to verify the native signed-policy enforcement.
      const readerArea = await protectedCollection(client, area, signal);
      try {
        const object = (await readerArea.read(objectId)).find(object => object.envelope.object === objectId)!, auth = readerArea.authorization();
        const definition = await required(client.query("zerotrust.domains.get", { domain: area.domain, generation: auth.keyGeneration }));
        const verified = await verifyDomain(definition, { tenant: account.tenant, id: area.domain, scope: area.scope, facet: area.facet, generation: auth.keyGeneration }, history.authority);
        const box = await required(client.query("zerotrust.keys.get", { domain: area.domain, generation: auth.keyGeneration }));
        const raw = await openBox(box, { tenant: account.tenant, purpose: "area-key", object: area.domain, generation: auth.keyGeneration, recipient: subject, author: box.author },
          unlockedAccount()!.identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, history.authority));
        const key = await areaKey(raw); raw.fill(0);
        const plain = bytes(JSON.stringify(object.value));
        try {
          const envelope = await encryptObject({ tenant: account.tenant, scope: area.scope, facet: area.facet, object: objectId, generation: auth.keyGeneration,
            revision: (BigInt(object.envelope.revision) + 1n).toString(), policyVersion: auth.policyVersion, author: subject }, plain, key, unlockedAccount()!.identity.signingKey.privateKey);
          const [, denied] = await peer.mutate("zerotrust.objects.batch", { objects: [{ domain: area.domain, messageId: `msg_${base64(randomSecret())}`, envelope }], heads: [{ domain: area.domain, sequence: readerArea.snapshot() }] });
          assert.ok(denied && "code" in denied); assert.equal(denied.code, "FORBIDDEN");
        } finally { plain.fill(0); }
      } finally { readerArea.close(); }
    } finally {
      const latest = await required(client.query("zerotrust.policy.get", undefined));
      await required(client.mutate("zerotrust.policy.replace", await signPolicy({ ...original, version: (BigInt((latest as { version: string }).version) + 1n).toString() }, authority)));
      await finishAccessChanges(client, signal);
    }
    const restored = createBusinessClient(observed, { productDriver: driver });
    try { assert.deepEqual(normalized(await required(restored.query("deliveryNotes.list", {}))), normalized(baseline)); }
    finally { restored.dispose(); }
    console.log("Encrypted delivery-note reads verified: exact source values, historical costs, separate per-project quantity/price keys, cross-facet snapshot race, denied cross-project reads, native reader-write denial, dishonest signed payload rejection, cross-instance live updates and no plaintext RPCs.");
  } finally { business.dispose(); await peer.logout(); }
}

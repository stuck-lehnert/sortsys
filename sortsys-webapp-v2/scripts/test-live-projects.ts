import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { prepareProjects } from "../app/lib/data/migrateProjects";
import { projectCollection, projectPayload } from "../app/lib/data/projectData";
import { required } from "../app/lib/data/protectedObjects";
import { until } from "./test-live-events";

export async function testProtectedProjects(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, baseline: QueryResult<"projects.list">,
  fixture: string, customerId: string, contactId: string, password: string) {
  const signal = new AbortController().signal;
  await prepareProjects(client, source, subject, signal);
  await prepareProjects(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "projects-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const requests: unknown[] = [], keys: string[] = []; let lose = false, falseAck = false, raceCustomer = false;
  const observed: Client = { ...client, query: ((path, input, options) => {
    requests.push({ path, input }); if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain); return client.query(path, input, options);
  }) as Client["query"], mutate: (async (path, input, options) => {
    requests.push({ path, input });
    if (path === "zerotrust.objects.batch") {
      if (falseAck) { falseAck = false; return [{ success: true, heads: (input as { heads: unknown }).heads }, null]; }
      if (raceCustomer) { raceCustomer = false; await required(other.mutate("customers.update", { id: customerId, data: { name: "Kunde zwischen Projektprüfung und Speicherung geändert" } })); }
      const result = await client.mutate(path, input, options);
      if (lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost project acknowledgement")]; } return result;
    }
    return client.mutate(path, input, options);
  }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  const sorted = <T extends { id: string }>(values: T[]) => values.slice().sort((a, b) => a.id.localeCompare(b.id));
  let stage = "legacy baseline";
  try {
    assert.deepEqual(sorted(await required(business.query("projects.list", {}))), sorted(baseline));
    assert.ok(keys.length >= baseline.length); assert.equal(keys.some(key => !/^project:[^:]+:master-data$/.test(key)), false, "Project discovery must not request calculation, personnel, customer or contact keys");
    assert.deepEqual(await required(business.query("projects.get", { id: fixture })), baseline.find(row => row.id === fixture));
    assert.ok((await required(business.query("projects.list", { search: "Regensburg Schulstraße" }))).some(row => row.id === fixture));
    for (const finished of [false, true]) assert.deepEqual(sorted(await required(business.query("projects.list", { finished }))), sorted(baseline.filter(row => !!row.finishedAt === finished)));
    assert.deepEqual(sorted(await required(business.query("projects.list", { customerId }))), sorted(baseline.filter(row => row.customerId === customerId)));
    assert.equal((await required(business.query("projects.contacts.list", { projectId: fixture })))[0]!.label, "Bauleitung");
    assert.ok((await required(business.query("contacts.projects.list", { contactId }))).some(row => row.id === fixture));
    stage = "validation before area provisioning";
    const domainCount = (await required(client.query("zerotrust.domains.list", undefined))).length;
    assert.ok((await business.mutate("projects.create", { title: " " }))[1]);
    assert.ok((await business.mutateDynamic("projects.create", { title: "Invalid date", orderReceivedAt: "2026-02-30T12:00:00Z" }))[1]);
    assert.ok((await business.mutate("projects.create", { title: "Unknown leader", responsibleProjectLeaderUserId: "7vvvvvvvvvvvv" }))[1]);
    assert.equal((await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).length, domainCount);
    stage = "normal project create, edit and subscription";
    const titles: string[][] = [], subscription = business.streamQuery("projects.list", { search: "Verschlüsseltes Projekt" }).subscribe(([rows, error]) => { if (!error && rows) titles.push(rows.map(row => row.title)); });
    try {
      lose = true;
      const created = await required(business.mutate("projects.create", { title: "Verschlüsseltes Projekt Schulhof", customerId,
        orderReceivedAt: new Date("2026-11-01T12:00:00Z"), address: { city: "Regensburg", streetAddress: "Innenhof 7" } }));
      assert.equal(lose, false); await until(() => titles.at(-1)?.includes("Verschlüsseltes Projekt Schulhof") ?? false, "project local subscription");
      assert.equal((await required(business.query("projects.get", { id: created.id }))).customerId, customerId);
      await required(business.mutate("projects.update", { id: created.id, data: { title: "Verschlüsseltes Projekt Schulhof geändert", customerId: null } }));
      falseAck = true;
      assert.ok((await business.mutate("projects.update", { id: created.id, data: { title: "Unbestätigte Projektänderung" } }))[1]);
      assert.equal((await required(business.query("projects.get", { id: created.id }))).title, "Verschlüsseltes Projekt Schulhof geändert");
      stage = "cross-instance customer reference race";
      raceCustomer = true;
      assert.ok((await business.mutate("projects.update", { id: created.id, data: { customerId } }))[1]);
      assert.equal((await required(business.query("projects.get", { id: created.id }))).customerId, null);
      await required(business.mutate("projects.update", { id: created.id, data: { customerId } }));
      stage = "project contacts and lifecycle";
      await required(business.mutate("projects.contacts.set", { projectId: created.id, contacts: [{ contactId, label: " Alt " }, { contactId, label: " Bauleitung Neubau " }] }));
      const linked = await required(business.query("projects.contacts.list", { projectId: created.id }));
      assert.equal(linked.length, 1); assert.equal(linked[0]!.label, "Bauleitung Neubau");
      await required(business.mutate("projects.contacts.add", { projectId: created.id, contactId, label: "Koordination" }));
      assert.equal((await required(business.query("projects.contacts.list", { projectId: created.id })))[0]!.label, "Koordination");
      await required(business.mutate("projects.contacts.remove", { projectId: created.id, contactId }));
      assert.deepEqual(await required(business.query("projects.contacts.list", { projectId: created.id })), []);
      await required(business.mutate("projects.finish", { id: created.id }));
      const finished = await required(business.query("projects.get", { id: created.id })); assert.ok(finished.finishedAt);
      await required(business.mutate("projects.finish", { id: created.id }));
      assert.deepEqual((await required(business.query("projects.get", { id: created.id }))).finishedAt, finished.finishedAt);
      await required(business.mutate("projects.resume", { id: created.id }));
      assert.equal((await required(business.query("projects.get", { id: created.id }))).finishedAt, null);
      assert.equal((await required(other.query("projects.get", { id: created.id }))).title, "Verschlüsseltes Projekt Schulhof geändert");
      await required(business.mutate("projects.delete", { id: created.id }));
      assert.ok((await business.query("projects.get", { id: created.id }))[1]);
      assert.equal((await required(business.query("projects.list", {}))).some(row => row.id === created.id), false);
    } finally { subscription.unsubscribe(); }
    for (const canary of ["Verschlüsseltes Projekt", "Innenhof 7", "Unbestätigte Projektänderung", "Bauleitung Neubau"]) assert.equal(JSON.stringify(requests).includes(canary), false);
    const area = projectCollection(fixture); assert.equal(area.scope, `project:${fixture}`);
    assert.throws(() => projectPayload({ format: "sortsys-project-v1", project: null, contacts: [] }, `project:${fixture}x`, fixture));
  } catch (cause) { throw new Error(`Protected projects failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
  console.log("Protected projects verified: legacy field equality, separate per-project keys, local search/filters, existing API calls, lifecycle, contact labels, subscriptions, lost acknowledgements, reference races and plaintext-free requests.");
}

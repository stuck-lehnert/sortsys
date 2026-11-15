import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareRegieReports } from "../app/lib/data/migrateRegieReports";
import { required } from "../app/lib/data/protectedObjects";

export async function testProtectedRegieReports(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, password: string,
  baseline: QueryResult<"regieReports.list">, costs: ReadonlyMap<string, QueryResult<"regieReports.costs.get">>) {
  const signal = new AbortController().signal;
  await prepareRegieReports(client, source, subject, signal); await prepareRegieReports(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "regie-reports-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const sent: { path: string; input: unknown }[] = []; let lost = false, discard = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discard) return [{ success: true }, null];
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lost && !result[1]) { lost = false; throw new Error("Lost regie acknowledgement"); }
      return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  const sorted = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  try {
    const all = await required(business.query("regieReports.list", { limit: 100000 }));
    for (const original of baseline) {
      const actual = all.find(report => report.id === original.id); assert.ok(actual);
      for (const field of ["id", "projectId", "summary", "createdByUserId", "autoId"] as const) assert.equal(actual[field], original[field]);
      assert.equal(actual.day.getTime(), original.day.getTime()); assert.equal(actual.createdAt.getTime(), original.createdAt.getTime());
      assert.deepEqual(sorted(actual.products), sorted(original.products)); assert.deepEqual(sorted(actual.specialRecords), sorted(original.specialRecords)); assert.deepEqual(sorted(actual.workHours), sorted(original.workHours));
      const before = costs.get(original.id); if (!before) continue;
      const after = await required(business.query("regieReports.costs.get", { id: original.id }));
      assert.equal(after.totalCost, before.totalCost); assert.deepEqual(after.products.map(line => line.priceRecord?.id ?? null).sort(), before.products.map(line => line.priceRecord?.id ?? null).sort());
    }
    const projects = await required(business.query("projects.list", {})); assert.ok(projects.length);
    const projectId = projects[0]!.id, day = "2025-08-04", summary = "Vertrauliche Regiearbeit 982745 Abdichtung";
    lost = true;
    const created = await required(business.mutate("regieReports.create", { projectId, day, summary,
      specialRecords: [{ name: "Sonderabdichtung 982745", unit: "m", amount: 2.375, comment: "Vor Ort" }], workHours: [{ day: "2025-08-05", hours: 3.125, userId: null }] }));
    assert.equal(lost, false);
    const initial = await required(business.query("regieReports.get", { id: created.id }));
    await other.invalidate("regieReports.get"); const onPeer = await required(other.query("regieReports.get", { id: created.id })); assert.equal(onPeer.summary, summary);
    await required(other.mutate("regieReports.update", { id: created.id, expectedRevision: onPeer.revision, expectedHoursRevision: onPeer.hoursRevision,
      data: { workHours: [{ id: onPeer.workHours[0]!.id, day: "2025-08-06", hours: 4.375, userId: null }] } }));
    await business.invalidate("regieReports.get");
    assert.ok((await business.mutate("regieReports.update", { id: created.id, expectedHoursRevision: initial.hoursRevision,
      data: { workHours: [{ id: initial.workHours[0]!.id, day: "2025-08-05", hours: 1, userId: null }] } }))[1]);
    const changed = await required(business.query("regieReports.get", { id: created.id })); assert.equal(changed.workHours[0]!.hours, 4.375); assert.equal(changed.specialRecords[0]!.amount, 2.375);
    discard = true; assert.ok((await business.mutate("regieReports.update", { id: created.id, data: { summary: "False success" } }))[1]); discard = false;
    assert.equal((await required(business.query("regieReports.get", { id: created.id }))).summary, summary);
    const wire = JSON.stringify(sent); assert.equal(wire.includes(summary), false); assert.equal(wire.includes("Sonderabdichtung 982745"), false); assert.equal(sent.some(call => call.path.startsWith("regieReports.")), false);
    console.log("Encrypted regie reports verified against pre-migration native reports and costs: repeatable conversion, exact quantities, separate working times, stable line IDs, two APIs, stale-hour rejection and false/lost acknowledgements.");
    return { id: created.id, summary };
  } finally { discard = lost = false; business.dispose(); other.dispose(); }
}

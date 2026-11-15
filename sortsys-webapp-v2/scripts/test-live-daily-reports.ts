import assert from "node:assert/strict";
import { createClient, type Client, type QueryResult } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareDailyReports } from "../app/lib/data/migrateDailyReports";
import { publicId, readBusinessRows } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";

/** Run by the disposable two-API migration stack; no plaintext daily-report
 * procedures are used once the source snapshot has been frozen. */
export async function testProtectedDailyReports(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal;
  await prepareDailyReports(client, source, subject, signal);
  await prepareDailyReports(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "daily-reports-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const sent: { path: string; input: unknown }[] = []; let lost = false, discard = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discard) return [{ success: true }, null];
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lost && !result[1]) { lost = false; throw new Error("Lost daily-report acknowledgement"); }
      return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  try {
    const reports = await readBusinessRows(source, "daily_project_reports"), hours = await readBusinessRows(source, "daily_project_report_work_hours");
    const all = await required(business.query("projects.dailyReports.list", { limit: 100000 }));
    for (const original of reports) {
      const actual = all.find(report => report.id === publicId(original.values.id)); assert.ok(actual);
      assert.equal(actual.projectId, publicId(original.values.project_id)); assert.equal(actual.day.toISOString().slice(0, 10), original.values.day);
      assert.equal(actual.summary, original.values.summary); assert.deepEqual(actual.weather, original.values.weather === null ? null : JSON.parse(original.values.weather as string));
      const entries = hours.filter(row => row.values.report_id === original.values.id); assert.equal(actual.workHours.length, entries.length);
      for (const entry of entries) {
        const line: QueryResult<"projects.dailyReports.get">["workHours"][number] | undefined = actual.workHours.find(hour => hour.id === publicId(entry.values.id)); assert.ok(line);
        assert.equal(line.hours, entry.values.hours); assert.equal(line.costPerHour, entry.values.cost_per_hour); assert.equal(line.contractType, entry.values.contract_type);
      }
    }
    const projects = await required(business.query("projects.list", {})); assert.ok(projects.length);
    const projectId = projects[0]!.id, used = new Set(all.filter(report => report.projectId === projectId).map(report => report.day.toISOString().slice(0, 10)));
    let date = new Date("2025-01-01T00:00:00Z"); while (used.has(date.toISOString().slice(0, 10))) date = new Date(date.getTime() + 86400000);
    const day = date.toISOString().slice(0, 10), summary = "Vertraulicher Tagesbericht 473891 Fassade";
    lost = true;
    await required(business.mutate("projects.dailyReports.create", { projectId, day, summary, workHours: [{ hours: 7.375, userId: null, costPerHour: 73.87654321, contractType: "external" }] }));
    assert.equal(lost, false);
    const created = await required(business.query("projects.dailyReports.get", { projectId, day }));
    await other.invalidate("projects.dailyReports.get");
    const onPeer = await required(other.query("projects.dailyReports.get", { projectId, day })); assert.equal(onPeer.id, created.id); assert.equal(onPeer.summary, summary);
    await required(other.mutate("projects.dailyReports.update", { projectId, day, expectedRevision: onPeer.revision,
      data: { workHours: [{ id: onPeer.workHours[0]!.id, userId: null, hours: 8.125, contractType: "external" }] } }));
    await business.invalidate("projects.dailyReports.get");
    assert.ok((await business.mutate("projects.dailyReports.update", { projectId, day, expectedRevision: created.revision, data: { summary: "Stale form" } }))[1]);
    const changed = await required(business.query("projects.dailyReports.get", { projectId, day }));
    assert.equal(changed.workHours[0]!.hours, 8.125); assert.equal(changed.workHours[0]!.costPerHour, 73.87654321);
    discard = true; assert.ok((await business.mutate("projects.dailyReports.update", { projectId, day, data: { summary: "Unconfirmed write" } }))[1]); discard = false;
    assert.equal((await required(business.query("projects.dailyReports.get", { projectId, day }))).summary, summary);
    const wire = JSON.stringify(sent); assert.equal(wire.includes(summary), false); assert.equal(wire.includes("73.87654321"), false);
    assert.equal(sent.some(request => request.path.startsWith("projects.dailyReports.")), false);
    console.log("Encrypted daily reports verified: repeatable source conversion, independent hourly costs, exact hours, stable line IDs, two-API read/write, stale forms, false/lost acknowledgements and ciphertext-only requests.");
    return { projectId, day, id: changed.id, summary };
  } finally { discard = lost = false; business.dispose(); other.dispose(); }
}

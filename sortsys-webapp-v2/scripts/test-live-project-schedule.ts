import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareProjectSchedule } from "../app/lib/data/migrateProjectSchedule";
import { newProductRowId, publicId, readBusinessRows } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";

/** Executed only by the disposable two-API migration stack. The source is the
 * verified archive, never the old plaintext planning procedures. */
export async function testProtectedProjectSchedule(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal;
  await prepareProjectSchedule(client, source, subject, signal); await prepareProjectSchedule(client, source, subject, signal);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "planning-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const sent: { path: string; input: unknown }[] = []; let lose = false, discard = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discard) return [{ success: true }, null];
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lose && !result[1]) { lose = false; throw new Error("Lost planning acknowledgement"); }
      return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  try {
    const range = { from: new Date("1900-01-01T00:00:00Z"), to: new Date("2200-01-01T00:00:00Z") };
    const original = await readBusinessRows(source, "project_deployments"), periods = await readBusinessRows(source, "project_unavailability_periods");
    const deployments = await required(business.query("projects.deployments.list", range)); assert.equal(deployments.length, original.length);
    for (const row of original) {
      const value = deployments.find(value => value.id === publicId(row.values.id)); assert.ok(value);
      assert.equal(value.projectId, publicId(row.values.project_id)); assert.equal(value.userId, publicId(row.values.user_id));
      assert.equal(value.from.getTime(), Date.parse(row.values.from as string)); assert.equal(value.to.getTime(), Date.parse(row.values.to as string)); assert.equal(value.note, row.values.note);
    }
    const actualPeriods = await required(business.query("projects.unavailability.list", {})); assert.equal(actualPeriods.length, periods.length);
    for (const row of periods) {
      const value = actualPeriods.find(value => value.id === publicId(row.values.id)); assert.ok(value);
      assert.equal(value.projectId, publicId(row.values.project_id)); assert.equal(value.from.toISOString().slice(0, 10), row.values.from);
      assert.equal(value.to.toISOString().slice(0, 10), row.values.to); assert.equal(value.reason, row.values.reason); assert.equal(value.note, row.values.note);
    }
    const projects = await required(business.query("projects.list", {})), people = await required(business.query("users.list", { deactivated: false }));
    assert.ok(projects.length && people.length);
    const projectId = projects[0]!.id, target = await required(business.mutate("projects.create", { title: "Ziel der verschlüsselten Einsatzplanung" }));
    const operationId = publicId(newProductRowId()), note = "Vertraulicher Personalwechsel 578429";
    const input = { operationId, projectId, userId: people[0]!.id, from: new Date("2026-03-27T06:00:00Z"), to: new Date("2026-03-27T14:00:00Z"), note };
    lose = true; assert.equal((await required(business.mutate("projects.deployments.create", input))).id, operationId); assert.equal(lose, false);
    await required(business.mutate("projects.deployments.create", input));
    const find = async (app: typeof business) => {
      const values = await required(app.query("projects.deployments.list", range)); const result = values.find(value => value.id === operationId); assert.ok(result); return result;
    };
    const first = await find(business); await other.invalidate("projects.deployments.list"); assert.equal((await find(other)).revision, first.revision);
    await required(other.mutate("projects.deployments.update", { id: operationId, expectedRevision: first.revision, data: { projectId: target.id } }));
    await business.invalidate("projects.deployments.list"); const moved = await find(business); assert.equal(moved.projectId, target.id);
    await required(business.mutate("projects.deployments.update", { id: operationId, expectedRevision: moved.revision, data: { projectId } }));
    const back = await find(business); assert.notEqual(back.revision, first.revision);
    assert.ok((await business.mutate("projects.deployments.update", { id: operationId, expectedRevision: first.revision, data: { note: "Stale form" } }))[1]);
    discard = true; assert.ok((await business.mutate("projects.deployments.delete", { id: operationId, expectedRevision: back.revision }))[1]); discard = false;
    assert.equal((await find(business)).note, note);
    lose = true; await required(business.mutate("projects.deployments.delete", { id: operationId, expectedRevision: back.revision })); assert.equal(lose, false);
    await other.invalidate("projects.deployments.list"); assert.equal((await required(other.query("projects.deployments.list", range))).some(value => value.id === operationId), false);
    const periodId = publicId(newProductRowId()), reason = "Vertrauliche Baustellensperre 584237";
    await required(business.mutate("projects.unavailability.create", { operationId: periodId, projectId, from: "2026-03-28", to: "2026-03-29", reason }));
    const serialized = JSON.stringify(sent); assert.equal(serialized.includes(note), false); assert.equal(serialized.includes(reason), false);
    assert.equal(sent.some(request => request.path.startsWith("projects.deployments.") || request.path.startsWith("projects.unavailability.")), false);
    console.log("Encrypted planning verified: repeatable source conversion, two API connections, exact ranges, atomic moves and return moves, stale forms, false/lost replies and ciphertext-only transport.");
    return { projectId, id: periodId, reason };
  } finally { lose = discard = false; business.dispose(); other.dispose(); }
}

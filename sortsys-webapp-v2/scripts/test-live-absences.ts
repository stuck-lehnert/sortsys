import assert from "node:assert/strict";
import { testTimestampEvidence } from "./test-live-timestamps";
import { createClient, type Client } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { absenceDecisionArea, absenceRequestArea, type AbsenceRequest } from "../app/lib/data/absenceData";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareAbsences } from "../app/lib/data/migrateAbsences";
import { newProductRowId, publicId, readBusinessRows } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { decodeBusinessRow } from "../app/lib/data/rowCodec";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { businessSchema } from "../app/lib/data/schema";
import { addressId } from "../app/lib/data/addressBook";

/** Prepared for the disposable two-API stack. It never sends absence contents
 * to a plaintext business procedure and does not start a development stack. */
export async function testProtectedAbsences(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal;
  await prepareAbsences(client, source, subject, signal, driver); await prepareAbsences(client, source, subject, signal, driver);
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "absences-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const sent: { path: string; input: unknown }[] = []; let lose = false, discard = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discard) return [{ success: true }, null];
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lose && !result[1]) { lose = false; throw new Error("Lost absence acknowledgement"); }
      return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  try {
    const original = await readBusinessRows(source, "user_vacations"), actual = await required(business.query("users.vacations.list", {})); assert.equal(actual.length, original.length);
    for (const row of original) {
      const value = actual.find(value => value.id === publicId(row.values.id)); assert.ok(value);
      assert.equal(value.userId, publicId(row.values.user_id)); assert.equal(value.from.toISOString().slice(0, 10), row.values.from); assert.equal(value.to.toISOString().slice(0, 10), row.values.to);
      assert.equal(value.status, row.values.status); assert.equal(value.type, row.values.absence_type); assert.equal(value.note, row.values.note); assert.equal(value.label, row.values.label);
      assert.equal(value.denialReason, row.values.denial_reason); assert.equal(value.decidedAt?.getTime() ?? null, row.values.decided_at === null ? null : Date.parse(row.values.decided_at as string));
      for (const [wire, column] of [[value.requestedByUserId, "requested_by_user_id"], [value.decidedByUserId, "decided_by_user_id"]] as const) assert.equal(wire, row.values[column] === null ? null : publicId(row.values[column]));
    }
    const session = await required(client.query("auth.sessionInfo", undefined)), userId = session.user.id, note = "Vertraulicher Abwesenheitsgrund 857246", id = publicId(newProductRowId());
    const input = { operationId: id, userId, from: "2026-12-21", to: "2026-12-23", type: "other" as const, label: "Schulung", note };
    lose = true; assert.deepEqual(await required(business.mutate("users.vacations.create", input)), { id, status: "approved" }); assert.equal(lose, false);
    assert.deepEqual(await required(business.mutate("users.vacations.create", input)), { id, status: "approved" });
    const find = async (app: typeof business, id: string) => { const value = (await required(app.query("users.vacations.list", {}))).find(value => value.id === id); assert.ok(value); return value; };
    await other.invalidate("users.vacations.list"); assert.equal((await find(other, id)).note, note);
    await testTimestampEvidence(client, peer, userId, id);
    const refused = publicId(newProductRowId()); discard = true;
    assert.ok((await business.mutate("users.vacations.create", { ...input, operationId: refused }))[1]); discard = false;
    assert.equal((await required(business.query("users.vacations.list", {}))).some(value => value.id === refused), false);
    // A valid pending source lets independently connected peers race a real
    // approval and denial without inventing an API-visible plaintext status.
    const pendingId = publicId(newProductRowId()), request = absenceRequestArea(userId), decision = absenceDecisionArea(userId), now = new Date().toISOString();
    const value: AbsenceRequest = { format: "sortsys-absence-request-v1", legacy: null, row: decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table: "user_vacations", values: {
      id: addressId(pendingId), user_id: addressId(userId), requested_by_user_id: addressId(userId), decided_by_user_id: null, status: "requested", denial_reason: null, decided_at: null,
      from: "2026-12-28", to: "2026-12-30", absence_type: "vacation", label: null, note: "Nicht an die API senden 482759", created_at: now, modified_at: now,
    } }) };
    const lease = acquireDataRuntime(observed, signal, driver);
    try { await lease.runtime.transaction([request, decision], tx => tx.create(request, request.area.prefix + pendingId, value)); } finally { lease.close(); }
    await other.invalidate("users.vacations.list"); const pending = await find(business, pendingId); assert.equal(pending.status, "requested");
    const results = await Promise.all([business.mutate("users.vacations.approve", { id: pendingId, expectedRevision: pending.revision }),
      other.mutate("users.vacations.deny", { id: pendingId, expectedRevision: pending.revision, reason: "Vertraulicher Ablehnungsgrund 957428" })]);
    assert.equal(results.filter(([, error]) => error === null).length, 1);
    await business.invalidate("users.vacations.list"); const decided = await find(business, pendingId); assert.notEqual(decided.status, "requested");
    assert.ok((await business.mutate("users.vacations.delete", { id: pendingId, expectedRevision: pending.revision }))[1]);
    discard = true; assert.ok((await business.mutate("users.vacations.delete", { id: pendingId, expectedRevision: decided.revision }))[1]); discard = false;
    assert.equal((await find(business, pendingId)).revision, decided.revision);
    lose = true; await required(business.mutate("users.vacations.delete", { id: pendingId, expectedRevision: decided.revision })); assert.equal(lose, false);
    await other.invalidate("users.vacations.list"); assert.equal((await required(other.query("users.vacations.list", {}))).some(value => value.id === pendingId), false);
    assert.ok((await business.mutate("users.vacations.create", { ...input, operationId: pendingId }))[1]);
    for (const text of [note, "Nicht an die API senden 482759", "Vertraulicher Ablehnungsgrund 957428"]) assert.equal(JSON.stringify(sent).includes(text), false);
    assert.equal(sent.some(request => request.path.startsWith("users.vacations.")), false);
    console.log("Encrypted absences verified: source preservation, two API connections, atomic decisions, stale forms, false/lost replies and ciphertext-only transport.");
    return { id, userId, note };
  } finally { lose = discard = false; business.dispose(); other.dispose(); }
}

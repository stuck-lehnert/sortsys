import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { preparePersonnel } from "../app/lib/data/migratePersonnel";
import { readBusinessRows, publicId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { personnelCollection } from "../app/lib/data/personnelData";

export async function testProtectedPersonnel(client: Client, source: BusinessDatabase, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal, owner = unlockedAccount()!, session = await required(client.query("auth.sessionInfo", undefined));
  await preparePersonnel(client, source, `user:${session.user.id}`, signal, driver);
  await preparePersonnel(client, source, `user:${session.user.id}`, signal, driver);
  const originals = await readBusinessRows(source, "users"), peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "personnel-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const sent: { path: string; input: unknown }[] = []; let lost = false, discard = false;
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch" && discard) return [{ success: true }, null];
      const reply = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lost && !reply[1]) { lost = false; return [null, new Error("Lost personnel acknowledgement")]; }
      return reply;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  try {
    const all = await required(business.query("users.list", { includeArchived: true }));
    for (const row of originals) {
      const actual = all.find(user => user.id === publicId(row.values.id))!; assert.ok(actual);
      for (const [property, column] of [["firstName", "first_name"], ["lastName", "last_name"], ["username", "username"], ["email", "email"], ["phone", "phone"], ["contractType", "contract_type"], ["costPerHour", "cost_per_hour"]]) assert.equal(actual[property as keyof typeof actual], row.values[column!]);
      assert.equal(actual.vacationDaysPerYear, row.values.vacation_days_per_year === null ? null : Number(row.values.vacation_days_per_year));
      assert.equal(actual.supervisorUserId, row.values.supervisor_user_id === null ? null : publicId(row.values.supervisor_user_id));
      assert.equal(actual.createdAt.getTime(), Date.parse(row.values.created_at as string)); assert.equal(actual.modifiedAt.getTime(), Date.parse(row.values.modified_at as string));
    }
    assert.equal((await required(business.query("users.get", { id: session.user.id }))).id, session.user.id, "The recovery administrator needs an ordinary encrypted directory profile");
    const active = all.filter(user => !user.deactivatedAt && !user.archivedAt), target = active.find(user => user.id !== session.user.id)!, manager = active.find(user => !user.supervisorUserId && user.id !== target.id)!;
    assert.ok(target); assert.ok(manager);
    const firstName = "Vertrauliche Vorarbeiterin 28471";
    lost = true;
    await required(business.mutate("users.update", { id: target.id, data: { firstName } })); assert.equal(lost, false);
    const renamed = await required(business.query("users.get", { id: target.id }));
    assert.equal(renamed.firstName, firstName); assert.equal(renamed.costPerHour, target.costPerHour); assert.equal(renamed.vacationDaysPerYear, target.vacationDaysPerYear);
    assert.ok((await required(business.query("users.list", { search: "Vorarbeiterin" }))).some(user => user.id === target.id));
    await other.invalidate("users.get"); assert.equal((await required(other.query("users.get", { id: target.id }))).firstName, firstName);
    await required(business.mutate("users.update", { id: target.id, data: { costPerHour: 89.87654321, vacationDaysPerYear: 31 } }));
    const priced = await required(business.query("users.get", { id: target.id })); assert.equal(priced.costPerHour, 89.87654321); assert.equal(priced.vacationDaysPerYear, 31); assert.equal(priced.firstName, firstName);
    const costArea = personnelCollection(target.id, "calculation");
    const masked: Client = { ...client, query: (async (path, input, options) => {
      if (path === "zerotrust.objects.list" && (input as { domain: string }).domain === costArea.domain) {
        const reply = await client.query("zerotrust.objects.list", input as { domain: string; prefix: string; after: null; snapshot: null }, options);
        return reply[0] ? [{ ...reply[0], objects: [], after: null }, null] : reply;
      }
      return client.query(path, input, options);
    }) as Client["query"] };
    const incomplete = createBusinessClient(masked, { productDriver: driver });
    try { assert.ok((await incomplete.query("users.get", { id: target.id }))[1], "A missing readable cost object must not be displayed as an unknown or NULL rate"); }
    finally { incomplete.dispose(); }
    if (target.supervisorUserId === manager.id) await required(business.mutate("users.update", { id: target.id, data: { supervisorUserId: null } }));
    await required(business.mutate("users.update", { id: target.id, data: { supervisorUserId: manager.id } }));
    const accessChange = await required(client.query("zerotrust.policy.get", undefined));
    assert.equal(accessChange.transaction?.author, `user:${session.user.id}`);
    assert.ok(accessChange.transaction?.packets.length);
    assert.ok(accessChange.transaction?.heads.some(head => head.domain === personnelCollection(target.id, "scope").domain));
    await other.invalidate("users.get"); assert.equal((await required(other.query("users.get", { id: target.id }))).supervisorUserId, manager.id);
    assert.ok((await business.mutate("users.update", { id: manager.id, data: { supervisorUserId: target.id } }))[1], "A client must reject supervisor cycles before publication");
    assert.ok((await business.mutate("users.update", { id: target.id, data: { supervisorUserId: target.id } }))[1]);
    assert.ok((await business.mutate("users.update", { id: target.id, data: { username: "must.not.rename.credentials" } }))[1]);
    discard = true; assert.ok((await business.mutate("users.update", { id: target.id, data: { firstName: "Not saved" } }))[1]); discard = false;
    assert.equal((await required(business.query("users.get", { id: target.id }))).firstName, firstName);
    const withoutLegacyRoles: Client = { ...observed, query: (async (path, input, options) => {
      if (path === "auth.sessionInfo") { const reply = await observed.query("auth.sessionInfo", undefined, options); return reply[0] ? [{ ...reply[0], roles: [] }, reply[1]] : reply; }
      return observed.query(path, input, options);
    }) as Client["query"] };
    const signed = createBusinessClient(withoutLegacyRoles, { productDriver: driver });
    try { await required(signed.mutate("users.update", { id: target.id, data: { phone: "091128471" } })); }
    finally { signed.dispose(); }
    const wire = JSON.stringify(sent);
    for (const secret of [firstName, "89.87654321", "091128471"]) assert.equal(wire.includes(secret), false);
    assert.equal(sent.some(request => request.path.startsWith("users.")), false);
    console.log("Encrypted personnel verified: source equality, per-person name/employment/cost keys, local search and edits, exact rates, supervisor-cycle denial, signed rights without legacy roles, cross-API readback, false/lost acknowledgements and no plaintext user calls.");
    return { id: target.id, firstName, costPerHour: 89.87654321 };
  } finally { discard = lost = false; business.dispose(); other.dispose(); }
}

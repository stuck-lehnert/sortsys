import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { acceptVault, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareTools } from "../app/lib/data/migrateTools";
import { readBusinessRows, publicId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { toolCollection } from "../app/lib/data/toolData";

export async function testProtectedTools(client: Client, source: BusinessDatabase, driver: () => Promise<DuckDriver>, password: string) {
  const signal = new AbortController().signal, owner = unlockedAccount()!, session = await required(client.query("auth.sessionInfo", undefined)), subject = `user:${session.user.id}`;
  await prepareTools(client, source, subject, signal);
  await prepareTools(client, source, subject, signal);
  const peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "tools-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVault(owner.exportKey, owner.vault, false);
  const sent: { path: string; input: unknown }[] = []; let lose = false, falseAck = false, race: (() => Promise<void>) | null = null;
  const observed: Client = { ...client, query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      if (path === "zerotrust.objects.batch") {
        if (falseAck) { falseAck = false; return [{ success: true, heads: (input as { heads: unknown }).heads }, null]; }
        if (race) { const work = race; race = null; await work(); }
        const result = await client.mutate(path, input, options); if (lose && !result[1]) { lose = false; return [null, new Error("Synthetic lost tool acknowledgement")]; } return result;
      }
      return client.mutate(path, input, options);
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver }), other = createBusinessClient(peer, { productDriver: driver });
  let stage = "migrated source equality";
  try {
    const originals = await readBusinessRows(source, "tools"), tools = await required(business.query("tools.list", {}));
    assert.equal(tools.length, originals.length);
    for (const row of originals) {
      const actual = tools.find(value => value.id === publicId(row.values.id))!; assert.ok(actual);
      for (const [property, column] of [["brand", "brand"], ["category", "category"], ["label", "label"], ["purchasePrice", "purchase_price"], ["usageCostPerDay", "usage_cost_per_day"], ["status", "status"]]) assert.equal(actual[property as keyof typeof actual], row.values[column!], `${property} ${actual.id}`);
      assert.equal(actual.customId, Number(row.values.custom_id)); assert.equal(actual.createdAt.getTime(), Date.parse(row.values.created_at as string));
    }
    const originalTrackings = await readBusinessRows(source, "tool_trackings"), tracking = await required(business.query("tools.trackings.list", { limit: 10000 }));
    assert.equal(tracking.length, originalTrackings.length);
    for (const row of originalTrackings) { const actual = tracking.find(value => value.id === publicId(row.values.id))!; assert.ok(actual); assert.equal(actual.toolUsageCostPerDay, row.values.tool_usage_cost_per_day); assert.equal(actual.toolId, publicId(row.values.tool_id)); assert.equal(actual.responsibleUserId, row.values.responsible_user_id === null ? null : publicId(row.values.responsible_user_id)); }
    assert.equal((await required(business.query("tools.inventories.list", {}))).length, (await readBusinessRows(source, "tool_inventories")).length);
    stage = "signed tracking rights without legacy management roles";
    const fixture = originals.find(row => row.values.category === "Freigabeprüfung" && row.values.label === "Werkzeug vor dem Kontowechsel")!;
    assert.ok(fixture); const originalTracking = originalTrackings.find(row => row.values.tool_id === fixture.values.id && row.values.ended_at === null)!;
    assert.ok(originalTracking); assert.notEqual(publicId(originalTracking.values.started_by_user_id), session.user.id);
    const members = await required(client.query("zerotrust.members.list", { after: null })), recipient = members.rows.find(row => row.id !== session.user.id)!; assert.ok(recipient);
    const signedRights: Client = { ...observed, query: (async (path, input, options) => {
      if (path === "auth.sessionInfo") {
        const reply = await observed.query("auth.sessionInfo", undefined, options);
        return reply[0] ? [{ ...reply[0], roles: [] }, reply[1]] : reply;
      }
      return observed.query(path, input, options);
    }) as Client["query"] };
    const managed = createBusinessClient(signedRights, { productDriver: driver });
    try {
      const request = await required(managed.mutate("tools.trackings.transfers.request", { toolTrackingId: publicId(originalTracking.values.id), transferToUserId: recipient.id }));
      await required(managed.mutate("tools.trackings.transfers.deny", { id: request.id }));
    } finally { managed.dispose(); }
    stage = "create, exact costs, description search and lost acknowledgement";
    const number = await required(business.query("tools.suggestNextCustomId", undefined));
    lose = true;
    const created = await required(business.mutate("tools.create", { customId: number, brand: "Geschützte Werkzeuge", category: "Fenstersanierung", label: "Profilfräse Vertraulich", purchasePrice: 1537.87654321, usageCostPerDay: 17.375 }));
    assert.equal(lose, false); assert.equal((await required(business.query("tools.get", { id: created.id }))).usageCostPerDay, 17.375);
    assert.equal((await required(business.query("tools.list", { search: "Profilfräse" }))).length, 1);
    assert.ok((await business.mutateDynamic("tools.create", { customId: number + 1, brand: "Invalid", category: "Invalid", unexpected: "private injection" }))[1]);
    assert.ok((await business.mutate("tools.create", { customId: number, brand: "Duplicate", category: "Duplicate" }))[1]);
    const project = await required(business.mutate("projects.create", { title: "Geschützter Werkzeugeinsatz" }));
    stage = "atomic booking, historical costs and failed writes";
    const booked = await required(business.mutate("tools.track", { id: created.id, data: { projectId: project.id, responsibleUserId: session.user.id, comment: "Nordflügel", deadlineAt: new Date(Date.now() - 1000) } }));
    assert.equal((await required(business.query("tools.get", { id: created.id }))).available, false);
    assert.ok((await business.mutate("tools.track", { id: created.id, data: {} }))[1]);
    let bookings = await required(business.query("tools.trackings.list", { toolId: created.id })); assert.equal(bookings.length, 1); assert.equal(bookings[0]!.id, booked.trackingId); assert.equal(bookings[0]!.toolUsageCostPerDay, 17.375);
    await required(business.mutate("tools.update", { id: created.id, data: { usageCostPerDay: 23.125 } }));
    assert.equal((await required(business.query("tools.trackings.list", { toolId: created.id })))[0]!.toolUsageCostPerDay, 17.375);
    falseAck = true; assert.ok((await business.mutate("tools.untrack", { id: created.id }))[1]); assert.equal((await required(business.query("tools.get", { id: created.id }))).available, false);
    stage = "inventories, transfer requests and continuation history";
    const inventory = await required(business.mutate("tools.inventories.create", { toolId: created.id, comment: "Werkzeug vollständig" }));
    assert.equal((await required(business.query("tools.inventories.list", { toolId: created.id })))[0]!.comment, "Werkzeug vollständig");
    assert.ok((await required(business.query("tools.inventories.overview", { hadInventory: true, days: 30 }))).some(value => value.id === created.id));
    await required(business.mutate("tools.inventories.delete", { id: inventory.id })); assert.equal((await required(business.query("tools.inventories.list", { toolId: created.id }))).length, 0);
    const denied = await required(business.mutate("tools.trackings.transfers.request", { toolTrackingId: booked.trackingId, transferToUserId: session.user.id }));
    await required(business.mutate("tools.trackings.transfers.deny", { id: denied.id }));
    const requested = await required(business.mutate("tools.trackings.transfers.request", { toolTrackingId: booked.trackingId, transferToUserId: session.user.id, notes: "Umbuchung geschützt" }));
    assert.ok((await business.mutate("tools.trackings.transfers.request", { toolTrackingId: booked.trackingId }))[1]);
    lose = true; await required(business.mutate("tools.trackings.transfers.accept", { id: requested.id })); assert.equal(lose, false);
    bookings = await required(business.query("tools.trackings.list", { toolId: created.id })); assert.equal(bookings.length, 2); assert.equal(bookings.filter(value => value.endedAt === null).length, 1);
    assert.equal(bookings.find(value => value.endedAt === null)!.toolUsageCostPerDay, 23.125); assert.equal(bookings.find(value => value.id === booked.trackingId)!.toolUsageCostPerDay, 17.375);
    const transfers = await required(business.query("tools.trackings.transfers.list", { toolId: created.id })); assert.equal(transfers.find(value => value.id === requested.id)!.status, "accepted");
    assert.ok((await business.mutate("tools.trackings.transfers.accept", { id: requested.id }))[1]);
    const noCosts: Client = { ...observed, query: ((path, input, options) => {
      if (path === "zerotrust.keys.get" && (input as { domain: string }).domain.endsWith(":procurement")) throw new Error("A tool return must not open cost keys");
      return observed.query(path, input, options);
    }) as Client["query"] };
    const operational = createBusinessClient(noCosts, { productDriver: driver });
    try {
      await required(operational.mutate("tools.update", { id: created.id, data: { label: "Profilfräse ohne Kostenzugriff geändert" } }));
      await required(operational.mutate("tools.untrack", { id: created.id }));
    } finally { operational.dispose(); }
    await business.invalidate("tools.get"); assert.equal((await required(business.query("tools.get", { id: created.id }))).available, true);
    assert.equal((await required(business.query("tools.get", { id: created.id }))).usageCostPerDay, 23.125);
    stage = "independent API instance wins competing booking";
    let winner: string | null = null;
    race = async () => { winner = (await required(other.mutate("tools.track", { id: created.id, data: { responsibleUserId: session.user.id } }))).trackingId; };
    assert.ok((await business.mutate("tools.track", { id: created.id, data: { responsibleUserId: session.user.id } }))[1]); assert.ok(winner); assert.equal(race, null);
    await business.invalidate("tools.trackings.list"); bookings = await required(business.query("tools.trackings.list", { toolId: created.id, finished: false })); assert.equal(bookings.length, 1); assert.equal(bookings[0]!.id, winner);
    stage = "archive, cascade and public namespace enforcement";
    await required(business.mutate("tools.archive", { id: created.id })); assert.ok((await required(business.query("tools.get", { id: created.id }))).archivedSince);
    await required(business.mutate("tools.unarchive", { id: created.id }));
    await required(business.mutate("tools.delete", { id: created.id }));
    assert.equal((await required(business.query("tools.list", { search: "Profilfräse" }))).length, 0); assert.equal((await required(business.query("tools.trackings.list", { toolId: created.id }))).length, 0); assert.equal((await required(business.query("tools.trackings.transfers.list", { toolId: created.id }))).length, 0);
    assert.ok((await business.query("tools.get", { id: created.id }))[1]);
    const area = toolCollection("tool", created.id, "master-data"), saved = await required(client.query("zerotrust.objects.get", { id: area.prefix }, { strategy: "network-only" }));
    assert.ok((await client.mutate("zerotrust.objects.save", { domain: area.domain, messageId: "invalid-tool-without-cas", envelope: saved }))[1]);
    assert.ok((await client.query("tools.list", {}))[1]);
    for (const marker of ["Profilfräse Vertraulich", "Werkzeug vollständig", "Umbuchung geschützt", "private injection", "1537.87654321"]) assert.equal(JSON.stringify(sent).includes(marker), false, marker);
    for (const request of sent.filter(request => request.path === "zerotrust.objects.batch")) assert.ok((request.input as { heads: unknown[] }).heads.length < 30, "Ordinary tool commands must not guard the entire tool history of the tenant");
  } catch (cause) { throw new Error(`Protected tools failed at ${stage}`, { cause }); }
  finally { business.dispose(); other.dispose(); }
  console.log("Encrypted tools verified: lossless source migration, isolated tool/tracking/cost areas, local search, CRUD, historical costs, inventories, transfer continuations, false/lost acknowledgements, atomic cross-API booking race, deletion and no plaintext business requests.");
}

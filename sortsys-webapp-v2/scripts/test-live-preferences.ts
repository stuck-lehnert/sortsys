import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { DEFAULT_GAEB_VIEW } from "@sortsys/gaeb";
import { acceptVaultWithKey, type UnlockedAccount } from "../app/lib/crypto/session";
import { createMemberInvitation, approveMemberInvitation, invitationMembers, signInMemberInvitation, joinMemberInvitation } from "../app/lib/crypto/invitations";
import { privateLlmCollection } from "../app/lib/data/privateLlm";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { preparePreferences } from "../app/lib/data/migratePreferences";
import { gaebViewCollection, preferenceCollection, preferenceDomain, preferencePayload } from "../app/lib/data/preferenceData";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { addressId } from "../app/lib/data/addressBook";
import { readBusinessRows, publicId } from "../app/lib/data/products";

export const MEMBER_VIEW = { showFields: false, outlineOpen: false, outlineWidth: 575, ribbonCollapsed: true, zoom: 1.375 };
export async function capturedPreferences(client: Client) {
  const values = new Map<string, typeof DEFAULT_GAEB_VIEW>(), signal = new AbortController().signal;
  for (const domain of await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))) {
    const subject = preferenceDomain(domain.id); if (!subject) continue;
    const collection = await protectedCollection(client, gaebViewCollection(subject), signal);
    try { const objects = await collection.read(); for (const object of objects) values.set(subject, preferencePayload(object.value, object.envelope.object, subject).view); }
    finally { collection.close(); }
  }
  return values;
}
export async function seedPreferences(client: Client, memberId: string) {
  const dsn = process.env.SORTSYS_MIGRATION_TEST_PG_DSN;
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1" || !dsn || !new URL(dsn).hostname.startsWith("sortsys-test-api-postgres-")) throw new Error("Disposable test tenant required");
  await required(client.mutate("personalization.gaebView.set", { ...DEFAULT_GAEB_VIEW, outlineWidth: 432, zoom: 1.125 }));
  const secondary = await required(client.mutate("users.create", { username: "preferences.reader", firstName: "Ansicht", lastName: "Ohne KI-Freigabe" }));
  await required(client.mutate("users.activate", { id: secondary.id }));
  const roles = await required(client.query("users.roles.list", undefined));
  await required(client.mutate("users.roles.set", { userId: secondary.id, assignments: Object.fromEntries(roles.map(role => [role, false])) as MutateInput<"users.roles.set">["assignments"] }));
  const database = new SQL(dsn);
  try {
    await database`INSERT INTO user_gaeb_view_preferences(user_id,preferences) VALUES(${addressId(memberId)},${database.json(MEMBER_VIEW)}::jsonb) ON CONFLICT(user_id) DO UPDATE SET preferences=EXCLUDED.preferences`;
    const [stored] = await database`SELECT jsonb_typeof(preferences) AS kind FROM user_gaeb_view_preferences WHERE user_id=${addressId(memberId)}`;
    assert.equal(stored.kind, "object");
  }
  finally { await database.close(); }
}

export async function testProtectedPreferences(client: Client, source: BusinessDatabase, owner: string, driver?: () => Promise<DuckDriver>) {
  const signal = new AbortController().signal;
  await preparePreferences(client, source, owner, signal); await preparePreferences(client, source, owner, signal);
  for (const row of await readBusinessRows(source, "user_gaeb_view_preferences")) {
    const subject = `user:${publicId(row.values.user_id)}`, area = gaebViewCollection(subject), collection = await protectedCollection(client, area, signal);
    try { const values = await collection.read(); assert.equal(values.length, 1); assert.deepEqual(preferencePayload(values[0]!.value, values[0]!.envelope.object, subject).view, { ...DEFAULT_GAEB_VIEW, ...JSON.parse(row.values.preferences as string) }); }
    finally { collection.close(); }
  }
  const sent: { path: string; input: unknown }[] = []; let lost = false, falseAck = 0;
  const observed: Client = { ...client, query: ((path, input, options) => { sent.push({ path, input }); assert.ok(!path.startsWith("personalization.")); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => { sent.push({ path, input }); assert.ok(!path.startsWith("personalization."));
      if (path === "zerotrust.objects.batch" && falseAck > 0) { falseAck--; return [{ success: true, heads: [] }, null]; }
      const result = await client.mutate(path, input, options); if (path === "zerotrust.objects.batch" && lost && !result[1]) { lost = false; return [null, new Error("Synthetic lost preference acknowledgement")]; } return result;
    }) as Client["mutate"] };
  const business = createBusinessClient(observed, { productDriver: driver });
  try {
    const original = await required(business.query("personalization.gaebView.get", undefined));
    const value = { ...original, showFields: false, outlineWidth: 511, zoom: 1.625 };
    lost = true; await required(business.mutate("personalization.gaebView.set", value)); assert.equal(lost, false);
    const fresh = createBusinessClient(observed, { productDriver: driver });
    try { assert.deepEqual(await required(fresh.query("personalization.gaebView.get", undefined)), value); } finally { fresh.dispose(); }
    falseAck = 3; assert.ok((await business.mutate("personalization.gaebView.set", { ...value, outlineWidth: 588 }))[1]);
    assert.deepEqual(await required(business.query("personalization.gaebView.get", undefined)), value);
    assert.ok((await business.queryDynamic("personalization.gaebView.get", { userId: "other" }))[1]);
    assert.ok((await business.mutateDynamic("personalization.gaebView.set", { ...value, title: "must remain private" }))[1]);
    for (const name of ["showFields", "outlineWidth", "ribbonCollapsed", "must remain private"]) assert.ok(!JSON.stringify(sent).includes(name));
    // Restore the source value for other workflow comparisons.
    await required(business.mutate("personalization.gaebView.set", original));
  } finally { business.dispose(); }
  console.log("Encrypted personal preferences verified: original user values, account-bound collections, durable reopen, lost/false acknowledgements and no plaintext preference RPCs.");
}

export async function testPreferenceReaders(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, signal: AbortSignal) {
  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const memberBusiness = createBusinessClient(memberClient);
  let firstSubject: string;
  try {
    firstSubject = `user:${(await required(memberClient.query("auth.sessionInfo", undefined))).user.id}`;
    assert.deepEqual(await required(memberBusiness.query("personalization.gaebView.get", undefined)), MEMBER_VIEW);
    const updated = { ...MEMBER_VIEW, outlineWidth: 488, zoom: 1.875 };
    await required(memberBusiness.mutate("personalization.gaebView.set", updated));
    const fresh = createBusinessClient(memberClient);
    try { assert.deepEqual(await required(fresh.query("personalization.gaebView.get", undefined)), updated); } finally { fresh.dispose(); }
    assert.ok((await memberBusiness.queryDynamic("personalization.gaebView.get", { userId: owner.username }))[1]);
  } finally { memberBusiness.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  const candidate = (await invitationMembers(ownerClient, signal)).find(member => member.username === "preferences.reader")!;
  assert.ok(candidate && !candidate.roles.includes(":llm"));
  const invitation = await createMemberInvitation(ownerClient, candidate, { catalogue: "none", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: false }, signal);
  const second = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "preferences-without-llm");
  await signInMemberInvitation(second, invitation.link, "Private-Views-No-LLM-2026!", signal);
  await joinMemberInvitation(second, invitation.link, signal);
  const { unlockedAccount } = await import("../app/lib/crypto/session");
  const secondaryAccount = unlockedAccount()!;
  await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  await approveMemberInvitation(ownerClient, invitation.link.invitation.id, signal);
  await acceptVaultWithKey(secondaryAccount.dataKey, secondaryAccount.vault, false);
  const secondary = createBusinessClient(second);
  try {
    assert.deepEqual(await required(secondary.query("personalization.gaebView.get", undefined)), DEFAULT_GAEB_VIEW);
    const value = { ...DEFAULT_GAEB_VIEW, outlineWidth: 477, showFields: false };
    await required(secondary.mutate("personalization.gaebView.set", value));
    assert.deepEqual(await required(secondary.query("personalization.gaebView.get", undefined)), value);
    const domains = await required(second.query("zerotrust.domains.list", undefined, { strategy: "network-only" }));
    assert.ok(!domains.some(domain => domain.id === privateLlmCollection(`user:${candidate.id}`).domain));
    assert.ok((await secondary.mutate("llm.chats.create", { title: "Denied without AI access" }))[1]);
    assert.ok((await second.query("zerotrust.keys.get", { domain: preferenceCollection(firstSubject!).domain, generation: "1" }, { strategy: "network-only" }))[1]);
    assert.ok((await secondary.mutateDynamic("personalization.gaebView.set", { ...value, userId: firstSubject }))[1]);
  } finally { secondary.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  console.log("Personal preferences verified for ordinary users: retained legacy settings, durable saves, cross-account denial and an invitation without AI roles or assistant keys.");
}

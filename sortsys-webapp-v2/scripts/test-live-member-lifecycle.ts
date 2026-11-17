import assert from "node:assert/strict";
import { SQL } from "bun";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount, type UnlockedAccount } from "../app/lib/crypto/session";
import { addressId } from "../app/lib/data/addressBook";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";
import { newAssistantId, openPrivateLlm, privateLlmCollection } from "../app/lib/data/privateLlm";
import { decodeMemberStatus } from "../app/lib/crypto/members";
import { memberPersonnelAccess } from "../app/lib/crypto/permissions";

export async function testMemberLifecycle(administrator: Client, memberClient: Client, member: UnlockedAccount, password: string, id: string, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const owner = unlockedAccount()!, location = new URL(process.env.SORTSYS_MIGRATION_TEST_PG_DSN!);
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1" || !location.hostname.startsWith("sortsys-test-api-postgres-")) throw new Error("Disposable tenant required");
  const database = new SQL(location.href), session = await required(administrator.query("auth.sessionInfo", undefined));
  const personal = privateLlmCollection(`user:${id}`), historyId = newAssistantId(), privateText = "Eigene vertrauliche Notiz zur Reaktivierung 63821";
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  try {
    const history = await openPrivateLlm(memberClient, signal);
    try { await history.save("chat", historyId, { text: privateText }); } finally { history.close(); }
  } finally { await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  assert.ok((await administrator.query("zerotrust.keys.get", { domain: personal.domain, generation: "1" }, { strategy: "network-only" }))[1]);
  let mode: "normal" | "drop" | "race" | "lost" = "normal";
  const attempts: MutateInput<"zerotrust.objects.batch">[] = [];
  const client: Client = { ...administrator, mutate: (async (path, input, options) => {
    if (path === "zerotrust.objects.batch" && (input as MutateInput<"zerotrust.objects.batch">).member) {
      attempts.push(structuredClone(input as MutateInput<"zerotrust.objects.batch">));
      if (mode === "drop") return [{ success: true, heads: [] }, null];
      if (mode === "race") await database`UPDATE users SET modified_at=clock_timestamp() WHERE id=${addressId(id)}::bigint`;
      const reply = await administrator.mutate(path, input, options);
      if (mode === "lost" && !reply[1]) { mode = "normal"; throw new Error("Lost combined account response"); }
      return reply;
    }
    return administrator.mutate(path, input, options);
  }) as Client["mutate"] };
  async function change(action: "activate" | "deactivate" | "archive" | "unarchive", target = id) {
    const business = createBusinessClient(client, { productDriver: driver });
    try { return await business.mutate(`users.${action}`, { id: target }); } finally { business.dispose(); }
  }
  async function profile() {
    const business = createBusinessClient(client, { productDriver: driver });
    try { return await required(business.query("users.get", { id })); } finally { business.dispose(); }
  }
  async function state() { return decodeMemberStatus(await required(administrator.query("zerotrust.members.status", { id }, { strategy: "network-only" }))); }
  try {
    const original = await profile(), before = await state(); assert.equal(original.deactivatedAt, null);
    assert.ok((await change("archive"))[1], "Active accounts cannot be archived");
    assert.ok((await change("deactivate", session.user.id))[1], "The authority owner cannot disable their own current session");
    mode = "drop"; const dropped = await change("deactivate"); assert.ok(dropped[1]); mode = "normal";
    assert.equal((await state()).deactivatedAt, null); assert.equal((await profile()).deactivatedAt, null);
    assert.equal((await required(administrator.query("zerotrust.policy.get", undefined))).suspended?.includes(`user:${id}`) ?? false, false);
    const captured = attempts.at(-1); assert.ok(captured?.member, `The account batch was not reached: ${dropped[1]?.stack ?? dropped[1]}`);
    assert.ok((await administrator.mutate("zerotrust.objects.batch", { ...captured, member: { ...captured.member, action: "activate" } }))[1], "A signed control cannot be rebound to another action");
    assert.equal((await profile()).deactivatedAt, null);
    mode = "race"; assert.ok((await change("deactivate"))[1]); mode = "normal";
    assert.notEqual((await state()).version, before.version);
    assert.equal((await state()).deactivatedAt, null); assert.equal((await profile()).deactivatedAt, null);
    const [rolledBack] = await database`SELECT count(*)::int AS count FROM __zerotrust_member_changes WHERE user_id=${addressId(id)}::bigint`;
    assert.equal(rolledBack.count, 0, "A late metadata conflict must roll back ciphertext pointers and the control receipt");

    mode = "lost"; await required(change("deactivate")); assert.equal(mode, "normal");
    const disabled = await state(), disabledProfile = await profile();
    assert.ok(disabled.deactivatedAt); assert.equal(disabledProfile.deactivatedAt!.getTime(), Date.parse(disabled.deactivatedAt!));
    assert.equal(disabledProfile.firstName, original.firstName); assert.equal(disabledProfile.costPerHour, original.costPerHour);
    assert.ok((await required(administrator.query("zerotrust.policy.get", undefined))).suspended?.includes(`user:${id}`));
    const suspendedAccess = await memberPersonnelAccess(administrator, `user:${id}`, signal);
    assert.ok(Object.keys(suspendedAccess).length > 0);
    assert.ok(Object.values(suspendedAccess).every(parts => Object.values(parts).every(level => level === "none")), "Access forms must apply the same global suspension as encryption and native API checks");
    assert.ok((await memberClient.query("auth.check", undefined, { strategy: "network-only" }))[1], "Deactivation destroys the old session");

    // Model a database operator restoring only the technical login flag. The
    // known password and private identity still must not open new area keys.
    await database`UPDATE users SET deactivated_at=NULL WHERE id=${addressId(id)}::bigint`;
    await signIn(memberClient, { tenant: member.tenant, username: member.username, password });
    assert.ok((await memberClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))[1], "The signed suspension vetoes a restored database login");
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
    await database`UPDATE users SET deactivated_at=${disabled.deactivatedAt}::timestamptz WHERE id=${addressId(id)}::bigint`;

    await required(change("archive")); assert.ok((await state()).archivedAt); assert.ok((await profile()).archivedAt);
    await required(change("unarchive")); assert.equal((await state()).archivedAt, null); assert.equal((await profile()).archivedAt, null);
    assert.ok((await profile()).deactivatedAt, "Unarchiving must not reactivate the account");
    await required(change("archive")); await required(change("activate"));
    const active = await state(), restored = await profile(); assert.equal(active.deactivatedAt, null); assert.equal(active.archivedAt, null);
    assert.equal(restored.deactivatedAt, null); assert.equal(restored.archivedAt, null); assert.equal(restored.firstName, original.firstName); assert.equal(restored.costPerHour, original.costPerHour);
    assert.equal((await required(administrator.query("zerotrust.policy.get", undefined))).suspended?.includes(`user:${id}`) ?? false, false);
    await signIn(memberClient, { tenant: member.tenant, username: member.username, password });
    const reader = createBusinessClient(memberClient, { productDriver: driver });
    try {
      assert.equal((await required(reader.query("users.get", { id }))).firstName, original.firstName);
      assert.ok((await reader.mutate("users.deactivate", { id: session.user.id }))[1]);
      const history = await openPrivateLlm(memberClient, signal);
      try { assert.deepEqual((await history.list("chat")).find(entry => entry.id === historyId)!.value, { text: privateText }); }
      finally { history.close(); }
    } finally { reader.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
    const currentPersonal = (await required(administrator.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).find(domain => domain.id === personal.domain)!;
    assert.ok((await administrator.query("zerotrust.keys.get", { domain: personal.domain, generation: currentPersonal.generation }, { strategy: "network-only" }))[1], "Reactivation must not give the administrator personal-history keys");
    signal.throwIfAborted();
    console.log("Protected account lifecycle verified: atomic profile/auth/policy changes, lost and false ACKs, rollback after a raced public version, self/ordinary-user denial, destroyed sessions, archive/unarchive semantics, operator-restored login veto and reactivation without losing individual grants or private costs.");
  } finally { mode = "normal"; await database.close(); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
}

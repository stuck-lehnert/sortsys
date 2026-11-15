import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { approveMemberInvitation, createMemberInvitation, signInMemberInvitation } from "../app/lib/crypto/invitations";
import { addressId } from "../app/lib/data/addressBook";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import type { UnlockedAccount } from "../app/lib/crypto/session";
import { testMemberLifecycle } from "./test-live-member-lifecycle";

export async function testMemberCreation(administrator: Client, memberClient: Client, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  const owner = unlockedAccount()!, location = new URL(process.env.SORTSYS_MIGRATION_TEST_PG_DSN!);
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1" || !location.hostname.startsWith("sortsys-test-api-postgres-")) throw new Error("Disposable tenant required");
  const database = new SQL(location.href), sent: { path: string; input: unknown }[] = [];
  const observe = (raw: Client): Client => ({ ...raw,
    query: ((path, input, options) => { sent.push({ path, input }); return raw.query(path, input, options); }) as Client["query"],
    mutate: ((path, input, options) => { sent.push({ path, input }); return raw.mutate(path, input, options); }) as Client["mutate"],
  });
  let loseCreation = true, loseProfile = true, discard = false;
  const observed = observe(administrator), faulty: Client = { ...observed, mutate: (async (path, input, options) => {
    if (path === "zerotrust.members.create" && discard) return [{ success: true }, null];
    const result = await observed.mutate(path, input, options);
    if (!result[1] && (path === "zerotrust.members.create" && loseCreation || path === "zerotrust.objects.batch" && loseProfile)) {
      if (path === "zerotrust.members.create") loseCreation = false; else loseProfile = false;
      return [null, new Error("Lost account creation response")];
    }
    return result;
  }) as Client["mutate"] };
  const input = { operationId: publicId(newProductRowId()), username: `neu.${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    firstName: "Vertraulicher Profilname 63821", lastName: "Zzz Testprofil", email: "vertraulich63821@example.invalid", phone: "091163821",
    costPerHour: 79.87654321, vacationDaysPerYear: 29, contractType: "internal" as const };
  const business = createBusinessClient(faulty, { productDriver: driver });
  try {
    const result = await required(business.mutate("users.create", input));
    assert.equal(result.id, input.operationId); assert.equal(loseCreation, false); assert.equal(loseProfile, false);
    assert.equal((await required(business.mutate("users.create", input))).id, result.id, "An exact retry must not create a second account");
    assert.ok((await business.mutate("users.create", { ...input, firstName: "Must not overwrite" }))[1]);
    assert.ok((await business.mutate("users.create", { ...input, operationId: publicId(newProductRowId()) }))[1], "A duplicate username must not create another technical account");
    const actual = await required(business.query("users.get", { id: result.id }));
    assert.equal(actual.firstName, input.firstName); assert.equal(actual.email, input.email); assert.equal(actual.costPerHour, input.costPerHour); assert.equal(actual.vacationDaysPerYear, 29);
    discard = true;
    const missing = { ...input, operationId: publicId(newProductRowId()), username: `${input.username}.missing` };
    assert.ok((await business.mutate("users.create", missing))[1]); discard = false;
    const absent = await database`SELECT id FROM users WHERE username=${missing.username}`; assert.equal(absent.length, 0);
    const [stored] = await database`SELECT first_name,last_name,email,phone,cost_per_hour,password,vacation_days_per_year FROM users WHERE id=${addressId(result.id)}::bigint`;
    assert.equal(stored.first_name, "Benutzer");
    for (const key of ["last_name", "email", "phone", "cost_per_hour", "password", "vacation_days_per_year"]) assert.equal(stored[key], null);
    const packet = sent.find(request => request.path === "zerotrust.members.create")!.input as MutateInput<"zerotrust.members.create">;
    assert.ok((await administrator.mutate("zerotrust.members.create", { ...packet, id: publicId(newProductRowId()), username: `${input.username}.forged` }))[1]);
    assert.ok((await administrator.mutateDynamic("zerotrust.members.create", { ...packet, firstName: "Reject this field" }))[1]);
    assert.ok((await memberClient.mutate("zerotrust.members.create", packet))[1], "A correctly signed request still needs a live administrator session");
    const wire = JSON.stringify(sent);
    for (const secret of [input.firstName, input.email, input.phone, String(input.costPerHour)]) assert.equal(wire.includes(secret), false);
    assert.equal(sent.some(request => request.path.startsWith("users.")), false);
  } finally { business.dispose(); await database.close(); }

  await acceptVaultWithKey(member.dataKey, member.vault, false);
  const colleague = createBusinessClient(memberClient, { productDriver: driver });
  try {
    const person = await required(colleague.query("users.get", { id: input.operationId }));
    assert.equal(person.firstName, input.firstName); assert.equal(person.costPerHour, null); assert.equal(person.vacationDaysPerYear, null);
    assert.ok((await colleague.mutate("users.create", { ...input, operationId: publicId(newProductRowId()), username: `${input.username}.denied` }))[1]);
  } finally { colleague.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }

  const invitation = await createMemberInvitation(administrator, { id: input.operationId, username: input.username },
    { catalogue: "none", vendors: "none", prices: "none", customers: "none", contacts: "none", assistant: true }, signal);
  const newcomer = observe(createClient(process.env.SORTSYS_LLM_TEST_PEER!, "new-account-invitation")), password = "New-Member-OPAQUE-63821!";
  await signInMemberInvitation(newcomer, invitation.link, password, signal);
  const joined = unlockedAccount()!;
  const technical = await required(newcomer.query("auth.sessionInfo", undefined));
  assert.deepEqual(Object.keys(technical.user).sort(), ["id", "locale", "username"]);
  assert.equal(JSON.stringify(technical).includes(input.firstName), false);
  assert.equal(JSON.stringify(technical).includes(input.email), false);
  assert.equal((await required(newcomer.query("zerotrust.status", undefined))).accessReady, false);
  await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  await approveMemberInvitation(administrator, invitation.link.invitation.id, signal);
  await acceptVaultWithKey(joined.dataKey, joined.vault, false);
  const active = createBusinessClient(newcomer, { productDriver: driver });
  try {
    const ownProfile = await required(active.query("users.get", { id: input.operationId }));
    assert.equal(ownProfile.firstName, input.firstName); assert.equal(ownProfile.costPerHour, null);
    assert.equal((await required(newcomer.query("zerotrust.status", undefined))).accessReady, true);
    assert.equal(JSON.stringify(sent).includes(password), false, "The new password must remain in the browser's OPAQUE worker");
  } finally { active.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, false); }
  await testMemberLifecycle(administrator, newcomer, joined, password, input.operationId, driver, signal);
  console.log("Protected account creation verified: technical-only SQL rows, exact creation/profile retries, false/lost replies, duplicate and forged request denial, independent API login via OPAQUE invitation, existing name readers and separate private fields.");
}

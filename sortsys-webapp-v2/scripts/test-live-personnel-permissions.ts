import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import type { DuckDriver } from "../app/lib/data/database";
import type { UnlockedAccount } from "../app/lib/crypto/session";
import { acceptVaultWithKey } from "../app/lib/crypto/session";
import { changePersonnelAccess, memberPersonnelAccess, shareNewPersonnelName } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { personnelCollection } from "../app/lib/data/personnelData";
import { required } from "../app/lib/data/protectedObjects";

export async function testPersonnelPermissions(ownerClient: Client, memberClient: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const actor = await required(memberClient.query("auth.sessionInfo", undefined)), ownerSession = await required(ownerClient.query("auth.sessionInfo", undefined));
  const read = createBusinessClient(ownerClient, { productDriver: driver });
  const people = await required(read.query("users.list", { deactivated: false })), original = people.find(person => person.id !== actor.user.id && person.id !== ownerSession.user.id)!; read.dispose(); assert.ok(original);
  const subject = `user:${actor.user.id}`, master = personnelCollection(original.id, "master-data"), costs = personnelCollection(original.id, "calculation");
  await changePersonnelAccess(ownerClient, subject, original.id, "master-data", "write", signal);
  const beforeDefault = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
  await shareNewPersonnelName(ownerClient, original.id, signal);
  assert.deepEqual(await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), beforeDefault,
    "Directory defaults must not downgrade custom write permissions or publish a redundant policy");
  await changePersonnelAccess(ownerClient, subject, original.id, "master-data", "none", signal);
  await changePersonnelAccess(ownerClient, subject, original.id, "calculation", "write", signal);
  await changePersonnelAccess(ownerClient, subject, original.id, "scope", "read", signal);
  assert.deepEqual((await memberPersonnelAccess(ownerClient, subject, signal))[original.id], { "master-data": "none", scope: "read", calculation: "write" });
  const deniedDefault = await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" }));
  await shareNewPersonnelName(ownerClient, original.id, signal);
  assert.deepEqual(await required(ownerClient.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), deniedDefault,
    "Directory defaults must retain explicit read denials and independent private grants");
  const calls: { path: string; input: unknown }[] = [];
  const observed: Client = { ...memberClient, query: ((path, input, options) => {
    calls.push({ path, input });
    if (path === "zerotrust.keys.get" && (input as { domain: string }).domain === master.domain) return Promise.resolve([null, new Error("No name key allowed")]);
    return memberClient.query(path, input, options);
  }) as Client["query"] };
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  const business = createBusinessClient(observed, { productDriver: driver });
  try {
    assert.ok((await business.query("users.get", { id: original.id }))[1]);
    await required(business.mutate("users.update", { id: original.id, data: { costPerHour: 91.125 } }));
    assert.ok((await business.mutate("users.update", { id: original.id, data: { vacationDaysPerYear: 32 } }))[1]);
    assert.ok((await business.mutate("users.update", { id: original.id, data: { firstName: "Not permitted" } }))[1]);
    const other = people.find(person => person.id !== original.id && person.id !== ownerSession.user.id)!; assert.ok(other);
    assert.ok((await business.mutate("users.update", { id: other.id, data: { costPerHour: 81.375 } }))[1]);
    assert.equal(calls.some(call => call.path === "zerotrust.keys.get" && (call.input as { domain: string }).domain === master.domain), false);
    assert.equal(calls.some(call => call.path.startsWith("users.")), false);
  } finally { business.dispose(); await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false); }
  const ownerView = createBusinessClient(ownerClient, { productDriver: driver });
  try {
    const changed = await required(ownerView.query("users.get", { id: original.id }));
    assert.equal(changed.costPerHour, 91.125); assert.equal(changed.firstName, original.firstName); assert.equal(changed.vacationDaysPerYear, original.vacationDaysPerYear);
    await required(ownerView.mutate("users.update", { id: original.id, data: { costPerHour: original.costPerHour } }));
  } finally { ownerView.dispose(); }
  await changePersonnelAccess(ownerClient, subject, original.id, "calculation", "none", signal);
  const current = (await required(ownerClient.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))).find(domain => domain.id === costs.domain)!;
  assert.ok((await memberClient.query("zerotrust.keys.get", { domain: costs.domain, generation: current.generation }, { strategy: "network-only" }))[1]);
  await changePersonnelAccess(ownerClient, subject, original.id, "scope", "none", signal);
  await changePersonnelAccess(ownerClient, subject, original.id, "master-data", "read", signal);
  console.log("Personnel permissions verified: cost-only updates without name keys, separate employment read grants, rejected cross-person writes and native denial after key rotation.");
}

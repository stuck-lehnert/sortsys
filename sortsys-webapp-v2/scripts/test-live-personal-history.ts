import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";

/** Uses the two real API peers from the disposable migration run. Neither
 * navigation targets nor shortcut labels are sent to personalization RPCs. */
export async function testProtectedPersonalHistory(client: Client, driver: () => Promise<DuckDriver>, password: string) {
  const owner = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "personal-history-peer");
  await signIn(peer, { tenant: owner.tenant, username: owner.username, password }); await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const sent: { path: string; input: unknown }[] = [];
  const observed: Client = { ...client, mutate: (async (path, input, options) => { sent.push({ path, input }); return client.mutate(path, input, options); }) as Client["mutate"] };
  const one = createBusinessClient(observed, { productDriver: driver }), two = createBusinessClient(peer, { productDriver: driver });
  try {
    const old = await required(one.query("personalization.visits.list", { limit: 100 }));
    await Promise.all([required(one.mutate("personalization.visits.append", { path: "/projects/7", title: "Privates Projekt 482731" })),
      required(two.mutate("personalization.visits.append", { path: "/projects/8", title: "Privates Projekt 947216" }))]);
    await one.invalidate("personalization.visits.list");
    const current = await required(one.query("personalization.visits.list", { limit: 100 }));
    assert.equal(current.filter(row => row.title === "Privates Projekt 482731").length, 1); assert.equal(current.filter(row => row.title === "Privates Projekt 947216").length, 1);
    assert.equal(current.length, Math.min(100, old.length + 2));
    const pin = { path: "/projects/7", title: "Angeheftet 682941", visitedAt: new Date("2026-11-12T12:00:00Z") };
    await one.dashboard.pin(pin); await two.invalidate("personalization.dashboard.pins.get"); assert.equal((await two.dashboard.get())[0]!.title, pin.title);
    await two.dashboard.unpin(pin.path); await one.invalidate("personalization.dashboard.pins.get"); assert.equal((await one.dashboard.get()).some(value => value.path === pin.path), false);
    await required(one.mutate("personalization.actions.append", { actionId: "offers.create", label: "Privater Aktionsname 467931", href: "/offers" }));
    await two.invalidate("personalization.actions.list"); assert.equal((await required(two.query("personalization.actions.list", {})))[0]!.label, "Privater Aktionsname 467931");
    const wire = JSON.stringify(sent); for (const text of [pin.title, "Privates Projekt 482731", "Privater Aktionsname 467931"]) assert.equal(wire.includes(text), false);
    assert.equal(sent.some(request => request.path.startsWith("personalization.")), false);
    console.log("Personal history verified across two APIs: concurrent visits, encrypted pin changes, private action labels and checked readback.");
  } finally { one.dispose(); two.dispose(); }
}

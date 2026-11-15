import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import type { DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { acceptVaultWithKey, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeCommercialCreation, changeMemberAccess, changeProjectCreation, memberAccess, memberCommercialCreation, memberProjectCreation } from "../app/lib/crypto/permissions";

export async function testMenuAccess(ownerClient: Client, peer: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const subject = `user:${(await required(peer.query("auth.sessionInfo", undefined))).user.id}`;
  const previous = (await memberAccess(ownerClient, subject, signal))!, projectCreation = await memberProjectCreation(ownerClient, subject, signal), commercialCreation = await memberCommercialCreation(ownerClient, subject, signal);
  const sent: string[] = [], observed: Client = { ...peer, query: ((path, input, options) => { sent.push(path); return peer.query(path, input, options); }) as Client["query"] };
  try {
    await changeProjectCreation(ownerClient, subject, false, signal); await changeCommercialCreation(ownerClient, subject, false, signal);
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "none", vendors: "read", prices: "write" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    let business = createBusinessClient(observed, { productDriver: driver });
    try {
      const view = await business.access.read(); assert.ok(view);
      assert.equal(view.role("view:products"), false); assert.equal(view.role("manage:productVendors"), false);
      assert.equal(view.role("view:productVendors"), true); assert.equal(view.role("manage:productPriceRecords"), true);
      assert.equal(view.canCreate("project"), false); assert.equal(view.canCreate("commercial"), false);
      assert.ok(sent.every(path => ["auth.sessionInfo", "zerotrust.trust.history", "zerotrust.policy.get", "zerotrust.creations.list"].includes(path)), "Menu decisions do not decrypt or search business data");
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeProjectCreation(ownerClient, subject, true, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    business = createBusinessClient(peer, { productDriver: driver });
    let projectId = "";
    try {
      const before = await business.access.read(); assert.ok(before); assert.equal(before.canCreate("project"), true); assert.equal(before.canCreate("commercial"), false);
      const epoch = business.access.context();
      const project = await required(business.mutate("projects.create", { title: "Menüfreigabe aus zertifizierter Projektanlage" })); projectId = project.id;
      assert.equal(epoch.aborted, true, "A successful creation must invalidate the old navigation projection");
      const after = await business.access.read(); assert.ok(after);
      assert.equal(after.can(`project:${project.id}`, "master-data", "update"), true, "Certified creation origins contribute actual scoped menu rights");
      assert.equal(after.canCreate("commercial"), false);
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeProjectCreation(ownerClient, subject, false, signal); await changeCommercialCreation(ownerClient, subject, true, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    business = createBusinessClient(peer, { productDriver: driver });
    try {
      const view = await business.access.read(); assert.ok(view);
      assert.equal(view.canCreate("project"), false); assert.equal(view.canCreate("commercial"), true); assert.equal(view.canSeeOffers(), true);
      assert.equal(view.can(`project:${projectId}`, "master-data", "update"), true, "Revoking creation does not remove already-created project access");
      const made = await required(business.mutate("commercial.cases.create", { kind: "offer", title: "Menüfreigabe für eigenständiges Angebot", scopeItemIds: [] }));
      const after = await business.access.read(); assert.ok(after); assert.equal(after.can(`commercial:${made.id}`, "master-data", "update"), true);
    } finally { business.dispose(); }
  } finally {
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, previous, signal);
    await changeProjectCreation(ownerClient, subject, projectCreation, signal); await changeCommercialCreation(ownerClient, subject, commercialCreation, signal);
  }
  console.log("Verified navigation access: independent supplier/price roles without content keys, separate project/offer creation, certified origin-derived item rights and retained existing project access after creation revocation.");
}

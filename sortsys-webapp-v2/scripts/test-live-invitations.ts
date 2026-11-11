import assert from "node:assert/strict";
import { SQL } from "bun";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { createIdentity, createInvitation, invitationClaimFrame, publicIdentity, sign } from "@sortsys/zerotrust";
import { acceptVault, trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { administratorInvitations, approveMemberInvitation, createMemberInvitation, invitationMembers, joinMemberInvitation, inspectMemberInvitation, signInMemberInvitation, memberInvitationUrl, revokeMemberInvitation } from "../app/lib/crypto/invitations";
import { required } from "../app/lib/data/protectedObjects";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { openProtectedProducts, PRICE_COLLECTION, PRODUCT_COLLECTION } from "../app/lib/data/products";
import { newAssistantId, openPrivateLlm, privateLlmCollection } from "../app/lib/data/privateLlm";
import { recoveryDraft, recoveryPlan } from "../app/lib/crypto/recovery";
import { testLiveAccessChanges } from "./test-live-permissions";
import { changeProjectCreation } from "../app/lib/crypto/permissions";
import { openAuthority } from "../app/lib/crypto/setup";
import type { DuckDriver } from "../app/lib/data/database";
import { ORGANIZATION_COLLECTION, NUMBERING_COLLECTION, PRINT_COLLECTION } from "../app/lib/data/organizationData";
import { readTemplateResource } from "../app/lib/data/printTemplateData";
import { testPositionPermissions } from "./test-live-position-permissions";
import { testPreferenceReaders } from "./test-live-preferences";
import { testStockPermissions } from "./test-live-stock";
import { testMenuAccess } from "./test-live-menu-access";

export async function testLiveInvitations(raw: Client, driver: () => Promise<DuckDriver>, recoveryPhrase: string, options: { onlyOrganization?: boolean; positions?: boolean } = {}) {
  const owner = unlockedAccount()!, endpoint = process.env.SORTSYS_MIGRATION_TEST_API!;
  const signal = new AbortController().signal, sent: { path: string; input: unknown }[] = [];
  const observe = (client: Client): Client => ({ ...client,
    query: ((path, input, options) => { sent.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: ((path, input, options) => { sent.push({ path, input }); return client.mutate(path, input, options); }) as Client["mutate"],
  });
  const administrator = observe(raw), member = (await invitationMembers(administrator, signal)).find(value => value.username === "frank.doe")!;
  assert.ok(member); assert.equal(member.enrolled, false);
  assert.ok(member.roles.includes(":llm"), "The fixture must explicitly retain the ordinary AI role; a crypto invitation does not grant application roles");
  const link = await createMemberInvitation(administrator, member, { catalogue: "read", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true }, signal);
  const withdrawn = await createMemberInvitation(administrator, member, { catalogue: "none", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: false }, signal);
  await revokeMemberInvitation(administrator, withdrawn.link.invitation.id, signal);
  const url = new URL(memberInvitationUrl(link, "https://sortsys.example"));
  assert.equal(url.pathname, "/auth/invitation"); assert.equal(url.search, ""); assert.ok(url.hash.length > 100);
  const peer = observe(createClient(process.env.SORTSYS_LLM_TEST_PEER ?? endpoint, "invited-member-integration"));
  let stage = "initial enrollment";
  // This disposable fixture changes only the technical phase marker. It does
  // not exercise or bypass production migration completion/erasure. The test
  // needs to prove that pending accounts never fall back to a clear password.
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("Disposable tenant required");
  const tenantDsn = process.env.SORTSYS_MIGRATION_TEST_PG_DSN, masterDsn = process.env.SORTSYS_MIGRATION_TEST_MASTER_DSN;
  if (!tenantDsn || !masterDsn) throw new Error("Explicit disposable database connections required");
  const tenantLocation = new URL(tenantDsn), masterLocation = new URL(masterDsn);
  if (!tenantLocation.hostname.startsWith("sortsys-test-api-postgres-") || tenantLocation.hostname !== masterLocation.hostname
    || ![tenantLocation, masterLocation].every(url => url.protocol === "postgres:" && url.username === "postgres")) {
    throw new Error("Disposable test-container database connections required");
  }
  const tenantDb = new SQL(tenantDsn), masterDb = new SQL(masterDsn);
  await tenantDb`UPDATE __zerotrust_state SET phase='active' WHERE singleton`;
  await masterDb`UPDATE __zerotrust_recovery_heads SET phase='active' WHERE tenant=${owner.tenant}`;
  try {
    const [forbiddenSource, sourceError] = await raw.query("zerotrust.migration.templateAsset", { id: "1" }, { strategy: "network-only" });
    assert.equal(forbiddenSource, null); assert.ok(sourceError && "code" in sourceError);
    assert.equal(sourceError.code, "FORBIDDEN", "An active tenant cannot reopen legacy plaintext template sources, even as administrator");
    const currentRoot = await trustedHistory(administrator), profile = await required(administrator.query("zerotrust.status", undefined, { strategy: "network-only" }));
    const authority = await openAuthority(administrator, profile.profile);
    const expired = await createInvitation({ tenant: owner.tenant, user: link.link.invitation.user, username: member.username,
      generation: currentRoot.current.generation, validUntil: (BigInt(Math.floor(Date.now() / 1000)) - 1n).toString() }, authority);
    // Simulate a database operator restoring an already expired, signed link
    // while extending only its mutable metadata. No timing-dependent sleep.
    await tenantDb`INSERT INTO __zerotrust_invitations(id,user_id,generation,invitation,expires_at)
      VALUES(${expired.invitation.id},(SELECT id FROM users WHERE username=${member.username}),
        ${expired.invitation.generation}::bigint,${tenantDb.json(expired.invitation)}::jsonb,now()+interval '1 day')`;
    const password = "Invited-Member-Test-2026!";
    assert.equal((await inspectMemberInvitation(peer, link.link, signal)).enrolled, false);
    await assert.rejects(() => signInMemberInvitation(peer, withdrawn.link, password, signal));
    const tampered: Client = { ...peer, mutate: ((path, input, options) => {
      if (path !== "auth.opaque.invitationFinish") return peer.mutate(path, input, options);
      const packet = input as MutateInput<"auth.opaque.invitationFinish">;
      const nonce = (packet.vault.nonce[0] === "A" ? "B" : "A") + packet.vault.nonce.slice(1);
      return peer.mutate("auth.opaque.invitationFinish", { ...packet, vault: { ...packet.vault, nonce } }, options);
    }) as Client["mutate"] };
    await assert.rejects(() => signInMemberInvitation(tampered, link.link, password, signal));
    assert.equal((await inspectMemberInvitation(peer, link.link, signal)).enrolled, false, "A substituted vault cannot complete registration");
    // A failed attempt and another unlocked account must never supply this identity.
    await signInMemberInvitation(peer, link.link, password, signal);
    assert.notEqual(unlockedAccount()!.vault.encryptionKey, owner.vault.encryptionKey);
    assert.notEqual(unlockedAccount()!.vault.signingKey, owner.vault.signingKey);
    assert.equal((await required(peer.query("zerotrust.status", undefined, { strategy: "network-only" }))).phase, "active");
    const enrollment = sent.findLast(request => request.path === "auth.opaque.invitationFinish")!.input;
    const noSession = createClient(endpoint, "invited-replay-test");
    assert.ok((await noSession.mutate("auth.opaque.invitationFinish", enrollment as MutateInput<"auth.opaque.invitationFinish">))[1], "Registration finalization must be one-time");
    const request = sent.find(request => request.path === "auth.opaque.invitationStart")!.input;
    assert.ok((await noSession.mutate("auth.opaque.invitationStart", request as MutateInput<"auth.opaque.invitationStart">))[1], "An invitation cannot overwrite an existing protected account");
    await assert.rejects(() => signInMemberInvitation(noSession, link.link, "Wrong-member-password!", signal));
    await signInMemberInvitation(peer, link.link, password, signal);
    assert.equal(sent.some(request => request.path === "auth.login" || request.path === "auth.opaque.enrollStart"), false);
    assert.equal(JSON.stringify(sent).includes(password), false);
    assert.ok((await noSession.query("auth.opaque.invitation", { tenant: owner.tenant, id: expired.invitation.id }, { strategy: "network-only" }))[1], "An extended database expiry cannot revive a signed expired invitation");
    await assert.rejects(() => joinMemberInvitation(peer, withdrawn.link, signal));
    stage = "accept invitation"; await joinMemberInvitation(peer, link.link, signal);
    const memberAccount = unlockedAccount()!;
    assert.equal(memberAccount.pins.recoveryGeneration, link.link.invitation.generation);
    assert.equal((await required(peer.query("zerotrust.status", undefined, { strategy: "network-only" }))).accessReady, false);
    assert.ok((await peer.query("zerotrust.policy.get", undefined, { strategy: "network-only" }))[1]);
    stage = "administrator confirmation"; await acceptVault(owner.exportKey, owner.vault, false);
    const waiting = (await administratorInvitations(administrator, signal)).find(value => value.link.invitation.id === link.link.invitation.id)!;
    assert.ok(waiting.entry?.claim);

    const attacker = await createIdentity(), fake = { ...waiting.entry.claim!, ...await publicIdentity(attacker) };
    fake.proof = await sign(attacker.signingKey.privateKey, invitationClaimFrame(fake, link.link.invitation));
    let approvals = 0;
    const substituted: Client = { ...administrator,
      query: (async (path, input, options) => {
        const result = await administrator.query(path, input, options);
        if (path !== "zerotrust.invitations.list" || result[1]) return result;
        return [(result[0] as Awaited<ReturnType<typeof administratorInvitations>>[number]["entry"][]).map(entry => entry && entry.invitation.id === fake.invitation ? { ...entry, claim: fake } : entry), null];
      }) as Client["query"],
      mutate: ((path, input, options) => { if (path === "zerotrust.invitations.approve") approvals++; return administrator.mutate(path, input, options); }) as Client["mutate"],
    };
    await assert.rejects(() => approveMemberInvitation(substituted, link.link.invitation.id, signal));
    assert.equal(approvals, 0, "An operator-substituted identity must fail the browser's secret confirmation before certification");

    let interrupted = false;
    const partial: Client = { ...administrator, mutate: ((path, input, options) => {
      if (path === "zerotrust.keys.grant" && !interrupted) { interrupted = true; return Promise.resolve([null, new Error("Synthetic interrupted grant")]); }
      return administrator.mutate(path, input, options);
    }) as Client["mutate"] };
    await assert.rejects(() => approveMemberInvitation(partial, link.link.invitation.id, signal));
    assert.equal(interrupted, true);
    await peer.invalidate("zerotrust.status");
    const intermediate = await required(peer.query("zerotrust.status", undefined, { strategy: "network-only" }));
    assert.equal(intermediate.accountCertified, true); assert.equal(intermediate.accessReady, false, "Certification alone must not report completed access");
    stage = "resume key grants";
    const personal = privateLlmCollection(link.link.invitation.user);
    let unpublished: MutateInput<"zerotrust.domains.put"> | null = null;
    // Fail after the master recovery copy commits but before the tenant can
    // publish this new domain. A retry must safely discard that unused draft.
    await tenantDb.unsafe("CREATE FUNCTION test_fail_domain_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic domain publication failure'; END $$");
    await tenantDb.unsafe("CREATE TRIGGER test_fail_domain_publication BEFORE INSERT ON __zerotrust_domains FOR EACH ROW EXECUTE FUNCTION test_fail_domain_publication()");
    try {
      await assert.rejects(() => approveMemberInvitation(administrator, link.link.invitation.id, signal));
      const [row] = await masterDb`SELECT definition FROM __zerotrust_recovery_keys WHERE tenant=${owner.tenant} AND domain_id=${personal.domain} AND domain_generation=1 AND recovery_generation=${currentRoot.current.generation}::bigint`;
      assert.ok(row); unpublished = row.definition;
      const absent = await tenantDb`SELECT id FROM __zerotrust_domains WHERE id=${personal.domain}`;
      assert.equal(absent.length, 0);
      const draft = await recoveryDraft(administrator, owner.tenant, recoveryPhrase, "Unused-Recovery-Plan-Test-2026!");
      const plan = await recoveryPlan(administrator, draft);
      assert.equal(plan.domains.some(domain => domain.id === personal.domain), false);
      assert.equal(plan.oldKeyEnvelopes.some(box => box.object === personal.domain), false, "An unpublished key draft must not obstruct recovery");
    } finally {
      await tenantDb.unsafe("DROP TRIGGER test_fail_domain_publication ON __zerotrust_domains");
      await tenantDb.unsafe("DROP FUNCTION test_fail_domain_publication()");
    }
    await approveMemberInvitation(administrator, link.link.invitation.id, signal);
    const published = await required(administrator.query("zerotrust.domains.get", { domain: personal.domain, generation: "1" }, { strategy: "network-only" }));
    assert.notEqual(published.proof, unpublished!.proof, "A fresh key must be able to replace an unpublished draft");
    assert.ok((await administrator.mutate("zerotrust.domains.put", unpublished!))[1], "A published key generation must remain immutable");
    await required(administrator.mutate("zerotrust.domains.put", published)); // Exact retry is safe.
    await approveMemberInvitation(administrator, link.link.invitation.id, signal); // Retry after an uncertain confirmation.
    await peer.invalidate("zerotrust.status");
    assert.equal((await required(peer.query("zerotrust.status", undefined, { strategy: "network-only" }))).accessReady, true);
    assert.ok((await raw.query("zerotrust.keys.get", { domain: personal.domain, generation: "1" }, { strategy: "network-only" }))[1], "The administrator must not receive the member's personal-history key");
    assert.ok((await raw.query("zerotrust.objects.list", { domain: personal.domain, prefix: "conversation:", after: null, snapshot: null }, { strategy: "network-only" }))[1]);
    const granted = sent.filter(request => request.path === "zerotrust.keys.grant").map(request => request.input as { domain: string; generation: string });
    assert.ok(granted.some(request => request.domain === PRODUCT_COLLECTION.domain && request.generation === "1"));
    assert.ok(granted.some(request => request.domain === PRODUCT_COLLECTION.domain && request.generation === "2"), "All catalogue generations must be distributed");
    assert.equal(granted.some(request => request.domain === PRICE_COLLECTION.domain), false);
    assert.ok(granted.some(request => request.domain === ORGANIZATION_COLLECTION.domain), "The normal invitation supplies the sender's address without extra key setup");
    assert.ok(granted.some(request => request.domain === PRINT_COLLECTION.domain), "Ordinary members must be able to print with the organization's template");
    assert.equal(granted.some(request => request.domain === NUMBERING_COLLECTION.domain), false, "Organization reading grants must not expose billing settings");
    stage = "member data access"; await acceptVault(memberAccount.exportKey, memberAccount.vault, false);
    const business = createBusinessClient(peer, { openProducts: (client, cancellation) => openProtectedProducts(client, cancellation, driver) });
    try {
      assert.equal((await required(business.query("settings.organization.get", undefined))).companyName, "Musterbetrieb Organisationsprüfung");
      assert.ok((await business.query("settings.invoiceNumbering.get", undefined))[1]);
      assert.ok((await peer.query("zerotrust.keys.get", { domain: NUMBERING_COLLECTION.domain, generation: "1" }, { strategy: "network-only" }))[1]);
      assert.ok((await business.mutate("settings.organization.set", { companyName: "Unauthorized member", address: null }))[1]);
      const template = await required(business.query("settings.documentTemplate.get", undefined));
      assert.match(template.source!, /Vertraulicher Musterkopf/);
      const logo = template.assets.find(asset => asset.mimeType === "image/png")!, resource = readTemplateResource(logo.downloadUrl!);
      assert.equal((await business.templates.blob(resource.id, resource.version)).size, logo.sizeBytes);
      assert.ok((await business.mutate("settings.documentTemplate.set", { source: "Unauthorized template", expectedRevision: template.revision }))[1]);
      await assert.rejects(() => business.templates.upload(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "Unauthorized.png", { type: "image/png" })));
      assert.ok((await required(business.query("products.list", { search: "Bogenberechnung" }))).length > 0);
      assert.ok((await business.query("products.priceRecords.list", {}))[1]);
      assert.ok((await business.mutate("products.create", { customId: 1999999999, name: "Must not be created", baseUnit: "m" }))[1]);
      const chat = await required(business.mutate("llm.chats.create", { title: "Privater Chat des eingeladenen Benutzers" }));
      assert.equal((await required(business.query("llm.chats.get", { chatId: chat.id }))).chat.title, "Privater Chat des eingeladenen Benutzers");
      assert.equal((await required(business.query("llm.chats.list", undefined))).length, 1);
      const history = await openPrivateLlm(peer, signal);
      try { const id = newAssistantId(); await history.save("chat", id, { text: "Persönlicher verschlüsselter Verlauf des eingeladenen Benutzers" }); assert.equal((await history.list("chat")).length, 1); }
      finally { history.close(); }
    } finally { business.dispose(); }
    stage = "personal preference readers without AI access";
    await testPreferenceReaders(administrator, peer, owner, memberAccount, signal);
    stage = "separate supplier and price permissions";
    await testStockPermissions(administrator, peer, owner, memberAccount, driver, signal);
    stage = "verified navigation and creation rights";
    await testMenuAccess(administrator, peer, owner, memberAccount, driver, signal);
    if (!options.onlyOrganization || options.positions) {
      stage = "ordinary member position search";
      await acceptVault(owner.exportKey, owner.vault, false);
      await testPositionPermissions(administrator, peer, owner, memberAccount, driver, signal);
    }
    if (options.onlyOrganization) {
      const requests = JSON.stringify(sent);
      for (const secret of [recoveryPhrase, link.link.secret, withdrawn.link.secret, "Privater Chat des eingeladenen Benutzers", "Persönlicher verschlüsselter Verlauf des eingeladenen Benutzers"]) assert.equal(requests.includes(secret), false);
      console.log("Organization/print onboarding verified: pinned member identity, interrupted approval and key publication, historical grants, private template/image access, denied settings writes and no billing keys.");
      return;
    }
    stage = "change member permissions";
    const accessCanary = await testLiveAccessChanges(administrator, peer, owner, memberAccount, driver, signal);
    stage = "bound delegated project creation";
    await changeProjectCreation(administrator, link.link.invitation.user, true, signal);
    await tenantDb.unsafe("INSERT INTO __zerotrust_domains(id,scope,facet,readers_hash,generation,policy_version) SELECT 'quota-test:'||n,'quota-test:'||n,'master-data',decode(repeat('00',32),'hex'),1,(SELECT policy_version FROM __zerotrust_state WHERE singleton) FROM generate_series(1,2000-(SELECT count(*)::int FROM __zerotrust_domains)) n");
    await acceptVault(memberAccount.exportKey, memberAccount.vault, false);
    const limited = createBusinessClient(peer, { productDriver: driver });
    try {
      const before = sent.length;
      assert.ok((await limited.mutate("projects.create", { title: "Delegated creation must respect the inventory limit" }))[1]);
      const attempt = sent.slice(before).find(request => request.path === "zerotrust.domains.put")?.input as MutateInput<"zerotrust.domains.put"> | undefined;
      assert.ok(attempt);
      const [, error] = await peer.mutate("zerotrust.domains.put", attempt);
      assert.match(error?.message ?? "", /Protected tenant area limit reached/);
      const [unpublished] = await masterDb`SELECT count(*)::int AS count FROM __zerotrust_recovery_keys WHERE tenant=${owner.tenant} AND domain_id=${attempt.id}`;
      assert.equal(unpublished.count, 0, "A quota rejection must precede durable key publication");
    } finally {
      limited.dispose(); await acceptVault(owner.exportKey, owner.vault, false);
      await tenantDb.unsafe("DELETE FROM __zerotrust_domains WHERE id LIKE 'quota-test:%'");
      await changeProjectCreation(administrator, link.link.invitation.user, false, signal);
    }
    stage = "recover creator-signed project keys";
    const createdAreas = await required(administrator.query("zerotrust.creations.list", undefined, { strategy: "network-only" }));
    assert.ok(createdAreas.length > 0);
    const recovery = await recoveryDraft(administrator, owner.tenant, recoveryPhrase, "Created-Area-Recovery-Test-2026!");
    const nextPlan = await recoveryPlan(administrator, recovery);
    for (const origin of createdAreas) {
      assert.ok(nextPlan.oldKeyEnvelopes.some(box => box.object === origin.id && box.generation === "1"), "Recovery inspect must include the original creator-signed key package");
      assert.ok(nextPlan.domains.some(domain => domain.id === origin.id));
    }
    const requests = JSON.stringify(sent);
    for (const secret of [accessCanary, recoveryPhrase, link.link.secret, withdrawn.link.secret, "Privater Chat des eingeladenen Benutzers", "Persönlicher verschlüsselter Verlauf des eingeladenen Benutzers"]) assert.equal(requests.includes(secret), false);
    console.log("Ordinary member onboarding verified: secret-confirmed identity, operator key-substitution denial, interrupted approval resumed, independent catalogue-only access across key generations, denied writes/prices and private user history without administrator key access.");
  } catch (cause) { throw new Error(`Member onboarding failed at ${stage}`, { cause }); }
  finally {
    await tenantDb`UPDATE __zerotrust_state SET phase='enrolling' WHERE singleton`;
    await masterDb`UPDATE __zerotrust_recovery_heads SET phase='enrolling' WHERE tenant=${owner.tenant}`;
    await tenantDb.close(); await masterDb.close();
    await acceptVault(owner.exportKey, owner.vault, false);
  }
}

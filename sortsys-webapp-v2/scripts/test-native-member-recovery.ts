import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import {
  base64,
  randomSecret,
  sign,
  recoveryMemberFrame,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  changeOwnPassword,
  lockCryptoSession,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newAssistantId, openPrivateLlm } from "../app/lib/data/privateLlm";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
assert.ok(root);
const [, , output] = process.argv.slice(2);
assert.ok(output);
const tenant = "member-recovery-tenant";
const owner = createClient(endpoints[0], "member-recovery-owner");
const member = createClient(endpoints[1], "member-recovery-user");
const oldDevice = createClient(endpoints[0], "member-recovery-device");
const signal = new AbortController().signal;
const originalPassword = "Original-member-recovery-password-2026!";
const racingPassword = "Concurrent-member-recovery-password-2026!";
const newPassword = "Recovered-member-password-2026!";
const ownerPassword = "Recovered-member-owner-password-2026!";
const privateName = "Privater Katalogeintrag nach Mitarbeiter-Recovery 73419";
const privateChat = "Vertraulicher persönlicher Verlauf 87214";
const wire: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") wire.push(args[1].body);
    const url = new URL(
      args[0] instanceof Request ? args[0].url : String(args[0]),
    );
    wire.push(...url.searchParams.values());
    return Reflect.apply(target, receiver, args);
  },
});
const access = {
  catalogue: "write" as const,
  customers: "none" as const,
  contacts: "none" as const,
  vendors: "none" as const,
  prices: "none" as const,
  assistant: true,
};
try {
  await signIn(owner, {
    tenant,
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  await initializeTenant(owner, signal, duckDriver);
  const administrator = unlockedAccount()!;
  let business = createBusinessClient(owner, { productDriver: duckDriver });
  const person = await required(
    business.mutate("users.create", {
      username: "recover.member",
      firstName: "Wiederherstellung",
      contractType: "internal",
    }),
  );
  business.dispose();
  const seed = JSON.parse(
    await readFile(join(root, "owner-recovery.json"), "utf8"),
  );
  assert.equal(seed.tenant, tenant);
  const invitation = await createMemberInvitation(
    owner,
    { id: person.id, username: "recover.member" },
    access,
    signal,
  );
  await signInMemberInvitation(
    member,
    invitation.link,
    originalPassword,
    signal,
  );
  await joinMemberInvitation(member, invitation.link, signal);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const pendingDraft = await recoveryDraft(
    owner,
    tenant,
    seed.phrase,
    ownerPassword,
    {
      restoreAdministrator: true,
      member: { username: "recover.member", password: newPassword },
    },
  );
  const pendingPlan = await recoveryPlan(owner, pendingDraft);
  assert.equal(pendingPlan.members![0]!.account.subject, `user:${person.id}`);
  assert.equal(pendingPlan.members![0]!.certificate.generation, "2");
  // Preparation and registration do not consume the phrase or replace the
  // pending credential. Ordinary invitation approval still works afterwards.
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(member, {
    tenant,
    username: "recover.member",
    password: originalPassword,
  });
  await signIn(oldDevice, {
    tenant,
    username: "recover.member",
    password: originalPassword,
  });
  const previousIdentity = (await trustedHistory(member)).identityCertificate(
    `user:${person.id}`,
  );
  business = createBusinessClient(member, { productDriver: duckDriver });
  const product = await required(
    business.mutate("products.create", {
      customId: 73419,
      name: privateName,
      baseUnit: "Stk",
    }),
  );
  business.dispose();
  const chatId = newAssistantId();
  let history = await openPrivateLlm(member, signal);
  await history.save("chat", chatId, { title: privateChat });
  history.close();

  // An ordinary session and its valid user key cannot replace the seed proof.
  const account = unlockedAccount()!;
  const nonce = base64(randomSecret());
  const [, forgedLookup] = await member.mutate("zerotrust.recovery.member", {
    tenant,
    generation: "1",
    username: "recover.member",
    nonce,
    proof: await sign(
      account.identity.signingKey.privateKey,
      recoveryMemberFrame(tenant, "1", "recover.member", nonce),
    ),
  });
  assert.ok(forgedLookup);
  const draft = await recoveryDraft(owner, tenant, seed.phrase, ownerPassword, {
    restoreAdministrator: true,
    member: { username: "recover.member", password: newPassword },
  });
  assert.equal(draft.member?.account.subject, `user:${person.id}`);
  const stale = await recoveryPlan(owner, draft);
  const forged = structuredClone(stale);
  forged.members![0]!.account.version = base64(randomSecret());
  await assert.rejects(() => commitRecovery(owner, forged));
  await changeOwnPassword(member, racingPassword);
  await signIn(oldDevice, {
    tenant,
    username: "recover.member",
    password: racingPassword,
  });
  assert.equal(
    (await required(oldDevice.query("auth.sessionInfo", undefined))).user.id,
    person.id,
  );
  await assert.rejects(() => commitRecovery(owner, stale));
  assert.equal(
    (
      await required(
        owner.query(
          "zerotrust.recovery.head",
          { tenant },
          { strategy: "network-only" },
        ),
      )
    ).generation,
    "1",
  );
  const beforeSuspension = await recoveryPlan(owner, draft);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  business = createBusinessClient(owner, { productDriver: duckDriver });
  await required(business.mutate("users.deactivate", { id: person.id }));
  await assert.rejects(() => commitRecovery(owner, beforeSuspension));
  await assert.rejects(() =>
    recoveryDraft(owner, tenant, seed.phrase, ownerPassword, {
      restoreAdministrator: true,
      member: { username: "recover.member", password: newPassword },
    }),
  );
  await required(business.mutate("users.activate", { id: person.id }));
  business.dispose();
  await signIn(oldDevice, {
    tenant,
    username: "recover.member",
    password: racingPassword,
  });
  assert.equal(
    (await required(oldDevice.query("auth.sessionInfo", undefined))).user.id,
    person.id,
  );
  const plan = await recoveryPlan(owner, draft);
  assert.notEqual(
    plan.members![0]!.account.version,
    stale.members![0]!.account.version,
  );
  await commitRecovery(owner, plan);
  const [, oldSession] = await oldDevice.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  assert.ok(oldSession);
  await lockCryptoSession();
  for (const password of [originalPassword, racingPassword]) {
    await assert.rejects(() =>
      signIn(member, { tenant, username: "recover.member", password }),
    );
  }
  await assert.rejects(() =>
    recoveryDraft(owner, tenant, seed.phrase, ownerPassword),
  );
  await signIn(member, {
    tenant,
    username: "recover.member",
    password: newPassword,
  });
  let session = await required(member.query("auth.sessionInfo", undefined));
  assert.equal(session.user.id, person.id);
  assert.deepEqual(session.roles, []);
  assert.deepEqual(
    await required(member.query("auth.passkeys.list", undefined)),
    [],
  );
  const current = (await trustedHistory(member)).identityCertificate(
    `user:${person.id}`,
  );
  assert.equal(current.generation, "2");
  assert.notEqual(current.signingKey, previousIdentity.signingKey);
  assert.notEqual(current.encryptionKey, previousIdentity.encryptionKey);
  await assert.rejects(() => openPrivateLlm(member, signal));

  async function verifyRestoredAccess(
    username: string,
    administratorPassword: string,
    memberPassword: string,
  ) {
    await signIn(owner, {
      tenant,
      username,
      password: administratorPassword,
    });
    assert.equal(unlockedAccount()!.vault.subject, administrator.vault.subject);
    business = createBusinessClient(owner, { productDriver: duckDriver });
    assert.equal(
      (await required(business.query("products.get", { id: product.id }))).name,
      privateName,
    );
    assert.equal(
      (await required(business.query("users.get", { id: person.id })))
        .firstName,
      "Wiederherstellung",
    );
    business.dispose();
    const recoveredOwner = unlockedAccount()!;
    const repeated = await createMemberInvitation(
      owner,
      { id: person.id, username: "recover.member" },
      access,
      signal,
    );
    await signInMemberInvitation(member, repeated.link, memberPassword, signal);
    await joinMemberInvitation(member, repeated.link, signal);
    await acceptVaultWithKey(
      recoveredOwner.dataKey,
      recoveredOwner.vault,
      recoveredOwner.username,
      false,
    );
    await approveMemberInvitation(
      owner,
      repeated.link.invitation.id,
      signal,
      duckDriver,
    );
    await signIn(member, {
      tenant,
      username: "recover.member",
      password: memberPassword,
    });
    business = createBusinessClient(member, { productDriver: duckDriver });
    assert.equal(
      (await required(business.query("products.get", { id: product.id }))).name,
      privateName,
    );
    business.dispose();
    const restoredHistory = await openPrivateLlm(member, signal);
    assert.deepEqual(
      (await restoredHistory.list("chat")).map(({ id, value }) => ({
        id,
        value,
      })),
      [{ id: chatId, value: { title: privateChat } }],
    );
    restoredHistory.close();
    const session = await required(member.query("auth.sessionInfo", undefined));
    assert.deepEqual(session.roles, []);
  }
  await verifyRestoredAccess(plan.username, ownerPassword, newPassword);
  await lockCryptoSession();
  for (const client of [owner, member, oldDevice]) client.setToken(null);
  const secondMemberPassword = "Second-recovered-member-password-2026!";
  const secondOwnerPassword = "Second-recovered-member-owner-password-2026!";
  const secondDraft = await recoveryDraft(
    owner,
    tenant,
    draft.newPhrase,
    secondOwnerPassword,
    {
      restoreAdministrator: true,
      member: { username: "recover.member", password: secondMemberPassword },
    },
  );
  const secondPlan = await recoveryPlan(owner, secondDraft);
  await commitRecovery(owner, secondPlan);
  await assert.rejects(() =>
    recoveryDraft(owner, tenant, draft.newPhrase, ownerPassword),
  );
  await assert.rejects(() =>
    signIn(member, {
      tenant,
      username: "recover.member",
      password: newPassword,
    }),
  );
  await signIn(member, {
    tenant,
    username: "recover.member",
    password: secondMemberPassword,
  });
  assert.equal(
    (await required(member.query("auth.sessionInfo", undefined))).user.id,
    person.id,
  );
  assert.equal((await trustedHistory(member)).current.generation, "3");
  await verifyRestoredAccess(
    secondPlan.username,
    secondOwnerPassword,
    secondMemberPassword,
  );
  for (const secret of [
    originalPassword,
    racingPassword,
    newPassword,
    ownerPassword,
    privateName,
    privateChat,
    seed.phrase,
    draft.newPhrase,
    secondDraft.newPhrase,
    secondOwnerPassword,
    secondMemberPassword,
  ]) {
    assert.equal(
      wire.some((request) => request.includes(secret)),
      false,
    );
  }
  await writeFile(
    output,
    JSON.stringify({
      success: true,
      member: person.id,
      pendingInvitationPrepared: true,
      passwordRaceRejected: true,
      suspensionRaceRejected: true,
      repeatedSeedRotation: true,
      seedRequired: true,
      memberRemainsOrdinary: true,
      privateHistoryRecovered: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const client of [owner, member, oldDevice]) client.setToken(null);
  await lockCryptoSession();
}

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient,
  RpcClientError,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import {
  base64,
  boxFrame,
  identityCertificate,
  openBox,
  openResourceCommandSigner,
  randomSecret,
  resourceCommandBinding,
  sign,
  signResourceCommand,
  signResourceAccess,
  TOOL_RETURN_PURPOSE,
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
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { TOOL_MODEL, toolCollection } from "../app/lib/data/toolData";

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
const toolBrand = "Montagegerät nach Wiederherstellung";
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

async function readBooking(trackingId: string) {
  const area = toolCollection("tool-tracking", trackingId, "master-data");
  const collection = await protectedCollection(member, area, signal);
  try {
    const [opened] = await collection.read();
    assert.ok(opened);
    const booking = TOOL_MODEL.decode(opened.value, area.prefix, area);
    assert.ok(booking.returnKey);
    return { key: booking.returnKey, revision: opened.envelope.revision };
  } finally {
    collection.close();
  }
}

async function retainReturnSigner(trackingId: string) {
  const { key } = await readBooking(trackingId);
  const account = unlockedAccount()!;
  const trust = await trustedHistory(member);
  const box = key.recipient;
  const seed = await openBox(
    box,
    {
      tenant,
      object: `tool-tracking:${trackingId}:return:${key.verificationKey}`,
      purpose: "resource-command-key",
      generation: box.generation,
      author: box.author,
      recipient: account.vault.subject,
    },
    account.identity.encryptionKey.privateKey,
    await trust.proofSigner(box.author, box.generation, box.signature, boxFrame(box)),
  );
  try {
    const signer = await openResourceCommandSigner({
      verificationKey: key.verificationKey,
      signingSeed: base64(seed),
    });
    return { signer, verificationKey: key.verificationKey };
  } finally {
    seed.fill(0);
  }
}

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
  business = createBusinessClient(owner, { productDriver: duckDriver });
  const project = await required(business.mutate("projects.create", {
    title: "Baustelle für Werkzeugrückgabe nach Recovery",
  }));
  const assignments: { toolId: string; trackingId: string }[] = [];
  for (const customId of [73420, 73421]) {
    const tool = await required(business.mutate("tools.create", {
      customId,
      brand: toolBrand,
      category: "Montage",
      usageCostPerDay: 18.75,
    }));
    const booking = await required(business.mutate("tools.track", {
      id: tool.id,
      data: { responsibleUserId: person.id, projectId: project.id },
    }));
    assignments.push({ toolId: tool.id, trackingId: booking.trackingId });
  }
  business.dispose();
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
  const retiredSigners = [
    [await retainReturnSigner(assignments[0]!.trackingId)],
    [await retainReturnSigner(assignments[1]!.trackingId)],
  ];
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

  async function returnRecoveredBooking(
    index: number,
    username: string,
    administratorPassword: string,
    memberPassword: string,
  ) {
    const { toolId, trackingId } = assignments[index]!;
    const booking = await readBooking(trackingId);
    for (const retired of retiredSigners[index]!) {
      assert.notEqual(booking.key.verificationKey, retired.verificationKey);
      const command = await signResourceCommand({
        tenant,
        purpose: TOOL_RETURN_PURPOSE,
        revision: booking.revision,
        issuedAt: String(Date.now()),
        verificationKey: retired.verificationKey,
      }, retired.signer);
      const [accepted, rejected] = await member.mutate(
        "zerotrust.toolReturns.publish", { trackingId, command },
      );
      assert.equal(accepted, null);
      assert.ok(rejected instanceof RpcClientError);
      assert.equal(rejected.code, "FORBIDDEN");
    }
    business = createBusinessClient(member, { productDriver: duckDriver });
    try {
      const rows = await required(business.query("tools.trackings.list", {}));
      const assigned = rows.find((row) => row.id === trackingId);
      assert.equal(assigned?.canReturnOwn, true);
      assert.equal(assigned?.toolUsageCostPerDay, null);
      assert.ok((await business.query("tools.get", { id: toolId }))[1]);
      if (index === 1 && process.env.SORTSYS_NATIVE_BROWSER === "1") {
        const { exerciseToolResponsibilityBrowser } =
          await import("./test-tool-responsibility-browser");
        await exerciseToolResponsibilityBrowser({
          tenant,
          member: { username: "recover.member", password: memberPassword },
          activeLabel: toolBrand,
          toolBrand,
          toolId,
          bookingDomain: toolCollection("tool-tracking", trackingId, "master-data").domain,
          artifactName: "recovered-member-tool-return",
          selfReturn: true,
        }, async () => {});
      } else {
        await required(business.mutate("tools.trackings.return", { trackingId }));
      }
      const remaining = await required(business.query("tools.trackings.list", {}, {
        strategy: "network-only",
      }));
      assert.equal(remaining.some((row) => row.id === trackingId), false);
    } finally {
      business.dispose();
    }
    await signIn(owner, { tenant, username, password: administratorPassword });
    business = createBusinessClient(owner, { productDriver: duckDriver });
    try {
      assert.equal((await required(business.query("tools.get", { id: toolId }))).available, true);
      const costs = await required(business.query("projects.costs.get", { projectId: project.id }));
      const usage = costs.toolTrackings.find((row) => row.id === trackingId);
      assert.ok(usage?.endedAt instanceof Date);
      assert.equal(usage.endedByUserId, person.id);
      assert.equal(usage.toolUsageCostPerDay, 18.75);
    } finally {
      business.dispose();
    }
  }

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
    // The production shell holds ordinary members until the administrator
    // completes the setup for the new authority generation.
    await initializeTenant(owner, signal, duckDriver);
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
    const firstRecovery = recoveredOwner.pins.recoveryGeneration === "2";
    const index = firstRecovery ? 0 : 1;
    const currentTracking = assignments[index]!.trackingId;
    const area = toolCollection("tool-tracking", currentTracking, "master-data");
    const formerSigner = retiredSigners[index]!.at(-1)!;
    let rejectedCheckpoint = false;
    const observedOwner: Client = {
      ...owner,
      mutate: (async (path, input, options) => {
        if (path === "zerotrust.objects.batch" && !rejectedCheckpoint) {
          const stale = structuredClone(input as MutateInput<"zerotrust.objects.batch">);
          const replacement = stale.objects.find(
            (entry) => entry.domain === area.domain && entry.resourceAccess?.active,
          );
          if (replacement?.resourceAccess) {
            const state = replacement.resourceAccess;
            const previousBinding = await resourceCommandBinding(formerSigner.verificationKey);
            assert.notEqual(state.commandBinding, previousBinding);
            const before = await required(owner.query("zerotrust.objects.get", {
              id: area.prefix,
            }, { strategy: "network-only" }));
            delete replacement.resourceAccess;
            const [unconfirmed, missingState] = await owner.mutate("zerotrust.objects.batch", stale);
            assert.equal(unconfirmed, null);
            assert.ok(missingState instanceof RpcClientError);
            assert.equal(missingState.code, "CONFLICT");
            replacement.resourceAccess = await signResourceAccess(
              {
                ...state,
                author: identityCertificate(state.author),
                commandBinding: previousBinding,
              },
              recoveredOwner.identity.signingKey.privateKey,
            );
            const [published, rejected] = await owner.mutate("zerotrust.objects.batch", stale);
            assert.equal(published, null);
            assert.ok(rejected instanceof RpcClientError);
            assert.equal(rejected.code, "CONFLICT");
            const after = await required(owner.query("zerotrust.objects.get", {
              id: area.prefix,
            }, { strategy: "network-only" }));
            assert.equal(after.signature, before.signature);
            rejectedCheckpoint = true;
          }
        }
        return owner.mutate(path, input, options);
      }) as Client["mutate"],
    };
    await approveMemberInvitation(
      observedOwner,
      repeated.link.invitation.id,
      signal,
      duckDriver,
    );
    assert.ok(rejectedCheckpoint);
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
    const visibleBookings = await required(business.query("tools.trackings.list", {}));
    const expectedBookingIds = firstRecovery
      ? assignments.map(({ trackingId }) => trackingId)
      : [assignments[1]!.trackingId];
    assert.deepEqual(
      visibleBookings.map(({ id }) => id).sort(),
      expectedBookingIds.sort(),
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
  retiredSigners[1]!.push(await retainReturnSigner(assignments[1]!.trackingId));
  await returnRecoveredBooking(0, plan.username, ownerPassword, newPassword);
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
  await returnRecoveredBooking(
    1, secondPlan.username, secondOwnerPassword, secondMemberPassword,
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
      toolReturnsRecovered: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  for (const client of [owner, member, oldDevice]) client.setToken(null);
  await lockCryptoSession();
}

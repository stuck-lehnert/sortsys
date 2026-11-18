import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  decryptSharedObject,
  encryptedObject,
  importSigningKey,
  type EncryptedObject,
} from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { readOwnAssignments } from "../app/lib/data/planningRecipients";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import type { PlanningScenario } from "./test-native-planning-recipients";

function sourceContext(envelope: EncryptedObject) {
  const {
    tenant,
    scope,
    facet,
    object,
    revision,
    generation,
    policyVersion,
    author,
  } = envelope;
  return {
    tenant,
    scope,
    facet,
    object,
    revision,
    generation,
    policyVersion,
    author,
  };
}

/** Recovery uses only the current phrase. Both the old account's key and its
 * former record grant remain insufficient for a fresh recipient revision. */
export async function exercisePlanningRecovery(
  owner: Client,
  member: Client,
  scenario: PlanningScenario,
  initialPhrase: string,
) {
  const signal = new AbortController().signal;
  const ownerSubject = unlockedAccount()!.vault.subject;
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  const note = "Erhaltener eigener Einsatz nach Recovery 628194";
  const assignment = await required(
    business.mutate("projects.deployments.create", {
      projectId: scenario.project.id,
      userId: scenario.member.id,
      from: new Date("2026-11-20T08:00:00Z"),
      to: new Date("2026-11-20T16:00:00Z"),
      note,
    }),
  );
  business.dispose();
  let phrase = initialPhrase;
  let memberPassword = scenario.member.password;
  let generation = "1";
  let ownerPassword = "";
  for (const round of [1, 2]) {
    await signIn(member, {
      tenant: scenario.tenant,
      username: scenario.member.username,
      password: memberPassword,
    });
    const oldAccount = unlockedAccount()!;
    const previous = await readOwnAssignments(member, signal);
    assert.equal(previous.length, 1);
    assert.equal(previous[0]!.value.row.values.note, note);
    const oldPage = await required(
      member.query(
        "zerotrust.objects.shared",
        { prefix: previous[0]!.id, snapshot: null, after: null },
        { strategy: "network-only" },
      ),
    );
    assert.equal(oldPage.objects.length, 1);
    const oldGrant = oldPage.objects[0]!.access;
    ownerPassword = `Recovered-planning-owner-password-${round}-2026!`;
    const nextMemberPassword = `Recovered-planning-member-password-${round}-2026!`;
    const draft = await recoveryDraft(
      owner,
      scenario.tenant,
      phrase,
      ownerPassword,
      {
        restoreAdministrator: true,
        member: {
          username: scenario.member.username,
          password: nextMemberPassword,
        },
      },
    );
    const plan = await recoveryPlan(owner, draft);
    await commitRecovery(owner, plan);
    assert.ok(
      (
        await member.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        })
      )[1],
    );
    await assert.rejects(
      signIn(member, {
        tenant: scenario.tenant,
        username: scenario.member.username,
        password: memberPassword,
      }),
    );
    await assert.rejects(
      recoveryDraft(owner, scenario.tenant, phrase, ownerPassword),
    );
    generation = (BigInt(generation) + 1n).toString();
    await signIn(member, {
      tenant: scenario.tenant,
      username: scenario.member.username,
      password: nextMemberPassword,
    });
    const session = await required(member.query("auth.sessionInfo", undefined));
    assert.equal(session.user.id, scenario.member.id);
    assert.deepEqual(session.roles, []);
    const history = await trustedHistory(member);
    assert.equal(history.current.generation, generation);
    assert.deepEqual(await readOwnAssignments(member, signal), []);
    assert.ok(
      (
        await member.query(
          "zerotrust.keys.get",
          {
            domain: `project:${scenario.project.id}:planning:master-data`,
            generation: "1",
          },
          { strategy: "network-only" },
        )
      )[1],
    );

    await signIn(owner, {
      tenant: scenario.tenant,
      username: plan.username,
      password: ownerPassword,
    });
    const administrator = unlockedAccount()!;
    assert.equal(administrator.vault.subject, ownerSubject);
    const ownerBusiness = createBusinessClient(owner, {
      productDriver: duckDriver,
    });
    try {
      const retained = await required(
        ownerBusiness.query("projects.deployments.list", {
          from: new Date("2026-11-01T00:00:00Z"),
          to: new Date("2026-12-01T00:00:00Z"),
          projectId: scenario.project.id,
        }),
      );
      assert.equal(
        retained.find((row) => row.id === assignment.id)?.note,
        note,
      );
    } finally {
      ownerBusiness.dispose();
    }
    const invitation = await createMemberInvitation(
      owner,
      { id: scenario.member.id, username: scenario.member.username },
      {
        catalogue: "none",
        customers: "none",
        contacts: "none",
        vendors: "none",
        prices: "none",
        assistant: false,
      },
      signal,
    );
    await signInMemberInvitation(
      member,
      invitation.link,
      nextMemberPassword,
      signal,
    );
    await joinMemberInvitation(member, invitation.link, signal);
    await acceptVaultWithKey(
      administrator.dataKey,
      administrator.vault,
      administrator.username,
      false,
    );
    await approveMemberInvitation(
      owner,
      invitation.link.invitation.id,
      signal,
      duckDriver,
    );
    await signIn(member, {
      tenant: scenario.tenant,
      username: scenario.member.username,
      password: nextMemberPassword,
    });
    const restored = await readOwnAssignments(member, signal);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.value.row.values.note, note);
    assert.equal(restored[0]!.value.projectTitle, scenario.project.title);
    const fresh = await required(
      member.query(
        "zerotrust.objects.shared",
        { prefix: restored[0]!.id, snapshot: null, after: null },
        { strategy: "network-only" },
      ),
    );
    const current = fresh.objects[0]!;
    assert.equal(current.access.access.generation, generation);
    assert.equal(current.access.recipientKey!.recipient.generation, generation);
    assert.notEqual(
      current.access.recipientKey!.recipient.encryptionKey,
      oldAccount.vault.encryptionKey,
    );
    const envelope = encryptedObject(current.envelope);
    const signer = await importSigningKey(
      current.access.access.author.signingKey,
    );
    await assert.rejects(
      decryptSharedObject({
        object: envelope,
        expected: sourceContext(envelope),
        objectSigner: signer,
        envelope: current.access.recipientKey!.envelope,
        share: {
          authorityGeneration: generation,
          recipient: `user:${scenario.member.id}`,
          author: envelope.author,
        },
        recipientKey: oldAccount.identity.encryptionKey.privateKey,
        grantSigner: signer,
      }),
    );
    await assert.rejects(
      decryptSharedObject({
        object: envelope,
        expected: sourceContext(envelope),
        objectSigner: signer,
        envelope: oldGrant.recipientKey!.envelope,
        share: {
          authorityGeneration: generation,
          recipient: `user:${scenario.member.id}`,
          author: envelope.author,
        },
        recipientKey: oldAccount.identity.encryptionKey.privateKey,
        grantSigner: signer,
      }),
    );
    await signIn(owner, {
      tenant: scenario.tenant,
      username: plan.username,
      password: ownerPassword,
    });
    phrase = draft.newPhrase;
    memberPassword = nextMemberPassword;
  }
  console.log(
    "Own planning recovery: two phrase-only recoveries retain assignments and account IDs, revoke old phrases/sessions/keys, and regrant exact record keys without parent access",
  );
  const administrator = unlockedAccount()!;
  return {
    phrase,
    owner: {
      username: administrator.username,
      password: ownerPassword,
      userId: administrator.vault.subject.slice(5),
    },
    member: { ...scenario.member, password: memberPassword },
  };
}

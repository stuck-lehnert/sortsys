import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import {
  certifyIdentity,
  publicIdentity,
  signingPair,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../app/lib/crypto/administration";
import {
  acceptVaultWithKey,
  enrollPasswordAccount,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";

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
const mode = process.argv[2];
const tenant = "passkey-tenant-a";
const client = createClient(endpoints[0], "passkey-account-lifecycle");
const signal = new AbortController().signal;
try {
  if (mode === "rename") {
    await signIn(client, {
      tenant,
      username: "builder",
      password: "Passkey-preserved-password-2026!",
    });
    await initializeTenant(client, signal, duckDriver);
    const session = await required(client.query("auth.sessionInfo", undefined));
    const business = createBusinessClient(client, {
      productDriver: duckDriver,
    });
    try {
      await required(
        business.mutate("users.update", {
          id: session.user.id,
          data: { username: "builder-updated" },
        }),
      );
    } finally {
      business.dispose();
    }
    process.stdout.write(
      JSON.stringify({ success: true, username: "builder-updated" }) + "\n",
    );
  } else if (mode === "create-member" || mode === "renew-member") {
    await signIn(client, {
      tenant,
      username: "builder-updated",
      password: "Passkey-preserved-password-2026!",
    });
    await initializeTenant(client, signal, duckDriver);
    const administrator = unlockedAccount()!;
    const context = await administratorContext(client, signal);
    const password = "Original-passkey-member-password-2026!";
    if (mode === "create-member") {
      const business = createBusinessClient(client, {
        productDriver: duckDriver,
      });
      let member;
      try {
        member = await required(
          business.mutate("users.create", {
            username: "passkey.member",
            firstName: "Passkey",
            contractType: "internal",
          }),
        );
      } finally {
        business.dispose();
      }
      const invitation = await createMemberInvitation(
        client,
        { id: member.id, username: "passkey.member" },
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
      await signInMemberInvitation(client, invitation.link, password, signal);
      await joinMemberInvitation(client, invitation.link, signal);
      await acceptVaultWithKey(
        administrator.dataKey,
        administrator.vault,
        administrator.username,
        false,
      );
      // The invitation login replaced this transport's token as well.
      await signIn(client, {
        tenant,
        username: "builder-updated",
        password: "Passkey-preserved-password-2026!",
      });
      await approveMemberInvitation(
        client,
        invitation.link.invitation.id,
        signal,
        duckDriver,
      );
    } else {
      await signIn(client, { tenant, username: "passkey.member", password });
      const account = unlockedAccount()!;
      const previous = (await trustedHistory(client)).identityCertificate(
        account.vault.subject,
      );
      const identity = { ...account.identity, signingKey: await signingPair() };
      const replacementCertificate = await certifyIdentity(
        {
          tenant,
          generation: previous.generation,
          user: previous.user,
          previousSignature: previous.signature,
          ...(await publicIdentity(identity)),
        },
        context.authority,
      );
      await enrollPasswordAccount(client, {
        tenant,
        username: "passkey.member",
        subject: previous.user,
        password: "Renewed-passkey-member-password-2026!",
        identity,
        replacementCertificate,
      });
    }
    process.stdout.write(JSON.stringify({ success: true }) + "\n");
  } else if (mode === "recover") {
    const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
    assert.ok(
      typeof root === "string" &&
        isAbsolute(root) &&
        basename(root).startsWith("sortsys-native-auth-"),
    );
    const source = JSON.parse(
      await readFile(join(root, "passkey-recovery-source.json"), "utf8"),
    );
    assert.equal(source.tenant, tenant);
    const draft = await recoveryDraft(
      client,
      tenant,
      source.phrase,
      "Recovered-passkey-test-password-2026!",
      { restoreAdministrator: true },
    );
    assert.equal(draft.administrator?.username, "builder-updated");
    const plan = await recoveryPlan(client, draft);
    assert.equal(plan.nextSetup.owner.user, draft.administrator?.subject);
    assert.equal(plan.username, "builder-updated");
    await commitRecovery(client, plan);
    await signIn(client, {
      tenant,
      username: plan.username,
      password: draft.password,
    });
    const restored = await required(
      client.query("auth.sessionInfo", undefined),
    );
    assert.equal(`user:${restored.user.id}`, draft.administrator?.subject);
    process.stdout.write(
      JSON.stringify({ success: true, username: plan.username }) + "\n",
    );
  } else throw new Error("Unknown native passkey lifecycle step");
} finally {
  client.setToken(null);
  await lockCryptoSession();
}

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import {
  createClient,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  approveMemberInvitation,
  createMemberInvitation,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
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
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const signal = new AbortController().signal;
const tenant = "new-tenant";
const ownerPassword = "Only-owner-knows-this-password-2026!";
const memberPassword = "Private-member-rename-password-2026!";
const originalName = "Vertrauliche Personalangabe 718639";
const changedName = "Geänderte vertrauliche Personalangabe 425173";
const originalFetch = globalThis.fetch;
const wire: string[] = [];
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") wire.push(args[1].body);
    const url = new URL(
      args[0] instanceof Request ? args[0].url : String(args[0]),
    );
    for (const value of url.searchParams.values()) wire.push(value);
    return Reflect.apply(target, receiver, args);
  },
});

const administrator = createClient(endpoints[0], "rename-administrator");
const peer = createClient(endpoints[1], "rename-peer-administrator");
const member = createClient(endpoints[1], "rename-member");
const observer = createClient(endpoints[0], "rename-observer");
const clients = [administrator, peer, member, observer];

let business: ReturnType<typeof createBusinessClient> | undefined;
let competitor: ReturnType<typeof createBusinessClient> | undefined;
let mode: "normal" | "discard" | "tamper" | "race" | "lose-reply" = "normal";
let personId = "";
let captured: MutateInput<"zerotrust.objects.batch"> | undefined;
const transport: Client = {
  ...administrator,
  mutate: (async (path, input, options) => {
    const batch = input as MutateInput<"zerotrust.objects.batch">;
    if (path !== "zerotrust.objects.batch" || !batch.member) {
      return administrator.mutate(path, input, options);
    }
    captured = structuredClone(batch);
    if (mode === "discard") return [{ success: true, heads: [] }, null];
    if (mode === "tamper") {
      return administrator.mutate(
        "zerotrust.objects.batch",
        {
          ...batch,
          member: { ...batch.member, username: "substituted.alias" },
        },
        options,
      );
    }
    if (mode === "race") {
      mode = "normal";
      await required(
        competitor!.mutate("users.update", {
          id: personId,
          data: { username: "renamed.concurrent" },
        }),
      );
    }
    const result = await administrator.mutate(path, input, options);
    if (mode === "lose-reply" && !result[1]) {
      mode = "normal";
      throw new Error("Lost response after atomic rename");
    }
    return result;
  }) as Client["mutate"],
};

try {
  console.log(
    "Native member rename: preparing an independent tenant and member",
  );
  await signIn(administrator, {
    tenant,
    username: "builder",
    password: ownerPassword,
  });
  await initializeTenant(administrator, signal, duckDriver);
  await signIn(peer, { tenant, username: "builder", password: ownerPassword });
  const owner = unlockedAccount()!;
  const ownerSession = await required(
    administrator.query("auth.sessionInfo", undefined),
  );
  const ownerCredential = await required(
    administrator.query("auth.opaque.vault", undefined),
  );
  business = createBusinessClient(transport, { productDriver: duckDriver });
  competitor = createBusinessClient(peer, { productDriver: duckDriver });
  const person = await required(
    business.mutate("users.create", {
      username: "rename.member",
      firstName: originalName,
      costPerHour: 73.125,
      contractType: "internal",
      supervisorUserId: ownerSession.user.id,
    }),
  );
  personId = person.id;
  const invitation = await createMemberInvitation(
    administrator,
    {
      id: personId,
      username: "rename.member",
    },
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
  await signInMemberInvitation(member, invitation.link, memberPassword, signal);
  await joinMemberInvitation(member, invitation.link, signal);
  const memberAccount = unlockedAccount()!;
  const memberSession = await required(
    member.query("auth.sessionInfo", undefined),
  );
  const memberCredential = await required(
    member.query("auth.opaque.vault", undefined),
  );
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  await approveMemberInvitation(
    administrator,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );

  // Each account switch deliberately closes old runtime contexts. Open fresh
  // facades afterwards, as a browser remount does.
  business.dispose();
  competitor.dispose();
  business = createBusinessClient(transport, { productDriver: duckDriver });
  competitor = createBusinessClient(peer, { productDriver: duckDriver });
  const read = () => required(business!.query("users.get", { id: personId }));
  const status = () =>
    required(
      administrator.query(
        "zerotrust.members.status",
        { id: personId },
        { strategy: "network-only" },
      ),
    );
  const before = await read();
  const beforeStatus = await status();
  assert.equal(before.username, "rename.member");

  console.log(
    "Native member rename: discarded and substituted commands leave both records unchanged",
  );
  for (const failure of ["discard", "tamper"] as const) {
    mode = failure;
    assert.ok(
      (
        await business.mutate("users.update", {
          id: personId,
          data: { username: "renamed.rejected", firstName: changedName },
        })
      )[1],
    );
    mode = "normal";
    assert.equal((await read()).username, before.username);
    assert.equal((await read()).firstName, before.firstName);
    assert.equal((await status()).version, beforeStatus.version);
  }
  assert.ok(captured?.member);
  for (const username of ["builder", ".invalid", "invalid..alias"]) {
    assert.ok(
      (
        await business.mutate("users.update", {
          id: personId,
          data: { username, firstName: changedName, costPerHour: 88.125 },
        })
      )[1],
    );
    assert.equal((await read()).username, before.username);
    assert.equal((await read()).costPerHour, before.costPerHour);
    assert.equal((await status()).version, beforeStatus.version);
  }

  console.log(
    "Native member rename: a concurrent rename wins without partial stale profile writes",
  );
  mode = "race";
  assert.ok(
    (
      await business.mutate("users.update", {
        id: personId,
        data: { username: "renamed.stale", firstName: changedName },
      })
    )[1],
  );
  assert.equal(mode, "normal");
  assert.equal((await status()).username, "renamed.concurrent");
  assert.equal((await read()).username, "renamed.concurrent");
  assert.equal((await read()).firstName, originalName);

  console.log(
    "Native member rename: lost acknowledgement preserves a combined rename, cost and supervisor change",
  );
  mode = "lose-reply";
  await required(
    business.mutate("users.update", {
      id: personId,
      data: {
        username: "renamed-final",
        firstName: changedName,
        costPerHour: 88.125,
        supervisorUserId: null,
      },
    }),
  );
  assert.equal(mode, "normal");
  const changed = await read();
  assert.equal(changed.username, "renamed-final");
  assert.equal(changed.firstName, changedName);
  assert.equal(changed.costPerHour, 88.125);
  assert.equal(changed.supervisorUserId, null);
  assert.equal((await status()).username, changed.username);
  const existingSession = await required(
    member.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  assert.equal(existingSession.user.username, changed.username);
  assert.equal(existingSession.session.id, memberSession.session.id);
  assert.deepEqual(
    await required(
      member.query("auth.opaque.vault", undefined, {
        strategy: "network-only",
      }),
    ),
    memberCredential,
  );

  await assert.rejects(() =>
    signIn(observer, {
      tenant,
      username: "rename.member",
      password: memberPassword,
    }),
  );
  await signIn(observer, {
    tenant,
    username: "renamed-final",
    password: memberPassword,
  });
  assert.equal(unlockedAccount()!.vault.subject, memberAccount.vault.subject);
  assert.equal(
    unlockedAccount()!.vault.signingKey,
    memberAccount.vault.signingKey,
  );
  const ordinary = createBusinessClient(observer, {
    productDriver: duckDriver,
  });
  try {
    assert.equal(
      (await required(ordinary.query("users.get", { id: personId }))).username,
      "renamed-final",
    );
    assert.ok(
      (
        await ordinary.mutate("users.update", {
          id: personId,
          data: { username: "unauthorized.alias" },
        })
      )[1],
    );
  } finally {
    ordinary.dispose();
  }

  console.log(
    "Native member rename: the administrator can rename their own account without rekeying",
  );
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  business.dispose();
  business = createBusinessClient(transport, { productDriver: duckDriver });
  await required(
    business.mutate("users.update", {
      id: ownerSession.user.id,
      data: { username: "builder.updated" },
    }),
  );
  const renamedOwner = await required(
    administrator.query("auth.sessionInfo", undefined, {
      strategy: "network-only",
    }),
  );
  assert.equal(renamedOwner.user.username, "builder.updated");
  assert.equal(renamedOwner.session.id, ownerSession.session.id);
  assert.deepEqual(
    await required(
      administrator.query("auth.opaque.vault", undefined, {
        strategy: "network-only",
      }),
    ),
    ownerCredential,
  );
  await signIn(peer, {
    tenant,
    username: "builder.updated",
    password: ownerPassword,
  });
  assert.equal(unlockedAccount()!.vault.subject, owner.vault.subject);
  assert.ok(
    wire.length > 20,
    "Wire checks must observe the actual RPC requests",
  );
  const transmitted = wire.join("\n");
  for (const secret of [
    originalName,
    changedName,
    "73.125",
    "88.125",
    memberPassword,
    ownerPassword,
  ]) {
    assert.equal(
      transmitted.includes(secret),
      false,
      "Private contents or passwords reached the wire",
    );
  }
  await writeFile(
    outputPath,
    JSON.stringify({
      success: true,
      renamed: true,
      rejectedPartialWrites: true,
      peerSessionsRetained: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  business?.dispose();
  competitor?.dispose();
  await lockCryptoSession();
  for (const client of clients) client.setToken(null);
}

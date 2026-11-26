import assert from "node:assert/strict";
import { exerciseNativeAbsences } from "./test-duckdb-absences";
import {
  createClient,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import { base64, randomSecret } from "@sortsys/zerotrust/sortsys";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { preparePrivateLlm } from "../app/lib/data/privateLlm";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import { MEMBER_ORGANIZATION_AREAS } from "../app/lib/data/organizationData";
import { MASTER_DATA_AREAS } from "../app/lib/crypto/accessProfiles";
import { administratorPolicyContext } from "../app/lib/crypto/administration";
import { publishVerifiedPolicy } from "../app/lib/crypto/policy";
import { changeMemberAccess, memberAccessState } from "../app/lib/crypto/permissions";
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  inspectMemberInvitation,
  invitationMembers,
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
const signal = new AbortController().signal;
const password = "New-member-only-knows-this-password-2026!";
const originalFetch = globalThis.fetch;
const bodies: string[] = [];
const requests: { paths: string[]; grantCount: number }[] = [];
let pauseCompletion = false;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const url = new URL(
      typeof args[0] === "string" || args[0] instanceof URL
        ? args[0]
        : args[0].url,
    );
    const body = args[1]?.body;
    if (typeof body === "string") bodies.push(body);
    const inputs = JSON.parse(
      typeof body === "string" ? body : (url.searchParams.get("input") ?? "{}"),
    );
    const paths = url.pathname.slice(1).split(",");
    let grantCount = 0;
    for (const [index, path] of paths.entries()) {
      if (path === "zerotrust.access.publish") {
        grantCount += inputs[String(index)].json.grants.length;
      }
    }
    requests.push({ paths, grantCount });
    if (pauseCompletion && paths.includes("zerotrust.invitations.complete")) {
      return Promise.reject(new Error("Connection interrupted before completing the invitation"));
    }
    return Reflect.apply(target, receiver, args).then(
      async (response: Response) => {
        const reply = await response.clone().json();
        for (const item of reply) {
          if (item.error) {
            const path = new URL(
              typeof args[0] === "string" || args[0] instanceof URL
                ? args[0]
                : args[0].url,
            ).pathname;
            console.log(
              `Native invitation rejected ${path}: ${item.error.json?.message}`,
            );
            if (path === "/zerotrust.keys.get") console.log(body);
          }
        }
        return response;
      },
    );
  },
});
const administrator = createClient(
  endpoints[0],
  "native-invitation-administrator",
);
const newcomer = createClient(endpoints[1], "native-invitation-newcomer");
const observer = createClient(endpoints[0], "native-invitation-observer");
let business: ReturnType<typeof createBusinessClient> | null = null;
try {
  await signIn(administrator, {
    tenant: "new-tenant",
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  const owner = unlockedAccount()!;
  const ownerSession = await required(
    administrator.query("auth.sessionInfo", undefined),
  );
  const subject = `user:${ownerSession.user.id}`;
  await provisionOwnedCollections(
    administrator,
    subject,
    [...MEMBER_ORGANIZATION_AREAS, ...Object.values(MASTER_DATA_AREAS)],
    signal,
  );
  await preparePrivateLlm(administrator, subject, signal);
  business = createBusinessClient(administrator, { productDriver: duckDriver });
  const input = {
    operationId: publicId(newProductRowId()),
    username: "native.invited",
    firstName: "Vertraulicher Profilname 98172",
    lastName: "Einladung",
    email: "native-private98172@example.invalid",
    phone: "091198172",
    costPerHour: 73.28197,
    vacationDaysPerYear: 28,
    contractType: "internal" as const,
    supervisorUserId: ownerSession.user.id,
  };
  console.log("Native invitation: creating personnel profile");
  const created = await required(business.mutate("users.create", input));
  const memberSubject = `user:${created.id}`;
  assert.equal(created.id, input.operationId);
  assert.equal(
    (await required(business.mutate("users.create", input))).id,
    created.id,
  );
  assert.equal(
    (await invitationMembers(administrator, signal)).find(
      (member) => member.id === created.id,
    )?.enrolled,
    false,
  );
  const product = await required(business.mutate("products.create", {
    customId: 98172,
    name: "Primer für mineralischen Untergrund",
    baseUnit: "l",
  }));
  const vendor = await required(business.mutate("products.vendors.create", {
    name: "Vertraulicher Lieferant 98172",
  }));
  const priceArea = MASTER_DATA_AREAS.prices;
  const policyContext = await administratorPolicyContext(administrator, signal);
  await publishVerifiedPolicy(administrator, policyContext, {
    ...policyContext.permissions,
    version: String(BigInt(policyContext.permissions.version) + 1n),
    rules: [...policyContext.permissions.rules, {
      subject: memberSubject,
      scope: priceArea.scope,
      facet: priceArea.facet,
      actions: ["read"],
      effect: "deny",
    }],
  });
  console.log("Native invitation: publishing invitation");
  const beforeInvitation = bodies.length;
  const invitation = await createMemberInvitation(
    administrator,
    {
      id: created.id,
      username: input.username,
    },
    {
      catalogue: "read",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: true,
      roles: ["organization-office", "organization-procurement"],
    },
    signal,
  );
  assert.doesNotMatch(bodies.slice(beforeInvitation).join("\n"), /organization-office|organization-procurement/);
  assert.deepEqual(
    await inspectMemberInvitation(newcomer, invitation.link, signal),
    { enrolled: false },
  );
  console.log("Native invitation: registering independent account");
  await signInMemberInvitation(newcomer, invitation.link, password, signal);
  const member = unlockedAccount()!;
  assert.equal(member.username, input.username);
  assert.equal(
    (await required(newcomer.query("zerotrust.status", undefined))).accessReady,
    false,
  );
  assert.ok((await newcomer.query("zerotrust.domains.list", undefined))[1]);
  // A denied operation clears only that transport's token. Sign in through
  // ordinary PAKE again; the reserved account can no longer be registered anew.
  await signIn(newcomer, {
    tenant: "new-tenant",
    username: input.username,
    password,
  });
  assert.deepEqual(
    await inspectMemberInvitation(observer, invitation.link, signal),
    { enrolled: true },
  );
  const pending = await required(
    newcomer.query("zerotrust.invitations.get", {
      id: invitation.link.invitation.id,
    }),
  );
  assert.ok(pending.entry.claim);
  const originalClaim = pending.entry.claim;
  await required(
    newcomer.mutate("zerotrust.invitations.join", {
      ...originalClaim,
      confirmation: base64(randomSecret()),
    }),
  );
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  await assert.rejects(
    () =>
      approveMemberInvitation(
        administrator,
        invitation.link.invitation.id,
        signal,
      ),
    "A valid account signature cannot replace knowledge of the invitation secret",
  );
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);
  await required(newcomer.mutate("zerotrust.invitations.join", originalClaim));
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  business.dispose();
  business = null;
  const lease = acquireDataRuntime(administrator, signal, duckDriver);
  try {
    const firstRequest = requests.length;
    console.log("Native invitation: approving and granting access");
    pauseCompletion = true;
    try {
      await assert.rejects(() =>
        approveMemberInvitation(administrator, invitation.link.invitation.id, signal),
      );
    } finally {
      pauseCompletion = false;
    }
    const approvalRequests = requests.slice(firstRequest);
    assert.ok(approvalRequests.some(({ paths }) => paths.includes("zerotrust.invitations.complete")));
    const publications = approvalRequests.filter(
      (request) => request.grantCount > 0,
    );
    assert.ok(publications.some((request) => request.grantCount > 1));
    assert.equal(
      approvalRequests.some((request) =>
        request.paths.includes("zerotrust.keys.grant"),
      ),
      false,
    );
    assert.ok(
      approvalRequests.some(
        (request) =>
          request.paths.filter((path) => path === "zerotrust.domains.get")
            .length > 1,
      ),
    );
    console.log(
      `Native invitation: ${publications.reduce((count, request) => count + request.grantCount, 0)} encrypted grants in ${publications.length} bounded publication request(s)`,
    );
    const waiting = await required(newcomer.query("zerotrust.status", undefined, { strategy: "network-only" }));
    assert.equal(waiting.accountCertified, true);
    assert.equal(waiting.accessReady, false);
    assert.ok((await newcomer.query("zerotrust.domains.list", undefined, { strategy: "network-only" }))[1]);
    console.log("Native invitation: certificate and published keys alone do not open the workspace");

    console.log("Native invitation: approving and granting access");
    await approveMemberInvitation(
      administrator,
      invitation.link.invitation.id,
      signal,
    );
  } finally {
    lease.close();
  }
  await signIn(newcomer, { tenant: "new-tenant", username: input.username, password });
  await acceptVaultWithKey(member.dataKey, member.vault, member.username, false);

  console.log("Native invitation: checking bounded definition reads as a member");
  const networkOnly = { strategy: "network-only" } as const;
  const domainKeys = [MASTER_DATA_AREAS.vendors, MASTER_DATA_AREAS.catalogue].map(
    ({ domain }) => ({ domain, generation: "1" }),
  );
  const definitions = await required(
    newcomer.query(
      "zerotrust.domains.selected",
      { keys: domainKeys },
      networkOnly,
    ),
  );
  assert.deepEqual(
    definitions.map(({ id }) => id),
    domainKeys.map(({ domain }) => domain),
  );
  for (const [index, key] of domainKeys.entries()) {
    const single = await required(
      newcomer.query("zerotrust.domains.get", key, networkOnly),
    );
    assert.deepEqual(definitions[index], single);
  }

  const deniedKey = { domain: priceArea.domain, generation: "1" };
  await required(
    administrator.query("zerotrust.domains.get", deniedKey, networkOnly),
  );
  const [partial, denied] = await newcomer.query(
    "zerotrust.domains.selected",
    { keys: [...domainKeys, deniedKey] },
    networkOnly,
  );
  assert.equal(partial, null);
  assert.equal(denied?.code, "FORBIDDEN");

  for (const keys of [[], [domainKeys[0]!, domainKeys[0]!]]) {
    const [result, error] = await newcomer.query(
      "zerotrust.domains.selected",
      { keys },
      networkOnly,
    );
    assert.equal(result, null);
    assert.equal(error?.code, "BAD_REQUEST");
  }

  console.log("Native invitation: reading own personnel profile");
  const reader = createBusinessClient(newcomer, { productDriver: duckDriver });
  try {
    const profile = await required(
      reader.query("users.get", { id: created.id }),
    );
    assert.equal(profile.firstName, input.firstName);
    assert.equal(profile.costPerHour, null);
    assert.equal(profile.vacationDaysPerYear, 28);
    assert.equal(
      (await required(newcomer.query("zerotrust.status", undefined)))
        .accessReady,
      true,
    );
    assert.equal((await required(reader.query("products.get", { id: product.id }))).id, product.id);
    assert.equal((await required(reader.query("products.vendors.get", { id: vendor.id }))).id, vendor.id);
    const customer = await required(reader.mutate("customers.create", {
      name: "Über Büro freigegebener Kunde 98172",
    }));
    assert.ok(customer.id);
    assert.ok((await reader.query("products.priceRecords.list", { productId: product.id }))[1]);
    assert.ok(
      (
        await newcomer.mutate(
          "zerotrust.invitations.create",
          invitation.link.invitation,
        )
      )[1],
    );
  } finally {
    reader.dispose();
  }
  // Reactivation restores the individual grants, but never the old sessions.
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  const access = await memberAccessState(administrator, memberSubject, signal);
  assert.ok(access);
  assert.deepEqual(access.roles, {
    "organization-office": true,
    "organization-procurement": true,
  });
  await changeMemberAccess(administrator, memberSubject, access.access, signal, {
    actions: {},
    roles: { "organization-office": false, "organization-procurement": false },
  });
  await approveMemberInvitation(administrator, invitation.link.invitation.id, signal);
  const afterReplay = await memberAccessState(administrator, memberSubject, signal);
  assert.deepEqual(afterReplay?.roles, {
    "organization-office": false,
    "organization-procurement": false,
  });
  assert.equal(afterReplay?.access.catalogue, "read");
  assert.equal(afterReplay?.access.customers, "none");
  assert.equal(afterReplay?.access.vendors, "none");

  await signIn(newcomer, { tenant: "new-tenant", username: input.username, password });
  const afterRevocation = createBusinessClient(newcomer, { productDriver: duckDriver });
  try {
    assert.equal((await required(afterRevocation.query("products.get", { id: product.id }))).id, product.id);
    assert.ok((await afterRevocation.query("products.vendors.get", { id: vendor.id }))[1]);
  } finally {
    afterRevocation.dispose();
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  }

  let accountWriteMode: "normal" | "discard" | "lose-reply" = "normal";
  let capturedChange: MutateInput<"zerotrust.objects.batch"> | null = null;
  const lifecycle: Client = {
    ...administrator,
    mutate: (async (path, input, options) => {
      if (
        path === "zerotrust.objects.batch" &&
        (input as MutateInput<"zerotrust.objects.batch">).member
      ) {
        capturedChange = structuredClone(
          input as MutateInput<"zerotrust.objects.batch">,
        );
        if (accountWriteMode === "discard")
          return [{ success: true, heads: [] }, null];
        const reply = await administrator.mutate(path, input, options);
        if (accountWriteMode === "lose-reply" && !reply[1]) {
          accountWriteMode = "normal";
          throw new Error("Lost acknowledgement after atomic account commit");
        }
        return reply;
      }
      return administrator.mutate(path, input, options);
    }) as Client["mutate"],
  };
  business = createBusinessClient(lifecycle, { productDriver: duckDriver });
  accountWriteMode = "discard";
  assert.ok((await business.mutate("users.deactivate", { id: created.id }))[1]);
  accountWriteMode = "normal";
  assert.equal(
    (
      await required(
        administrator.query(
          "zerotrust.members.status",
          { id: created.id },
          { strategy: "network-only" },
        ),
      )
    ).deactivatedMicros,
    null,
  );
  const attempted =
    capturedChange as MutateInput<"zerotrust.objects.batch"> | null;
  assert.ok(attempted?.member);
  assert.ok(
    (
      await administrator.mutate("zerotrust.objects.batch", {
        ...attempted,
        member: { ...attempted.member, action: "activate" },
      })
    )[1],
  );
  console.log(
    "Native invitation: deactivating member with a lost acknowledgement",
  );
  accountWriteMode = "lose-reply";
  await required(business.mutate("users.deactivate", { id: created.id }));
  assert.equal(accountWriteMode, "normal");
  assert.ok(
    (
      await newcomer.query("auth.check", undefined, {
        strategy: "network-only",
      })
    )[1],
  );
  await assert.rejects(() =>
    signIn(observer, {
      tenant: "new-tenant",
      username: input.username,
      password,
    }),
  );
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  business.dispose();
  business = createBusinessClient(administrator, { productDriver: duckDriver });
  await required(business.mutate("users.archive", { id: created.id }));
  await required(business.mutate("users.unarchive", { id: created.id }));
  const inactive = await required(
    business.query("users.get", { id: created.id }),
  );
  assert.ok(inactive.deactivatedAt);
  assert.equal(inactive.archivedAt, null);
  await required(business.mutate("users.activate", { id: created.id }));
  await signIn(observer, {
    tenant: "new-tenant",
    username: input.username,
    password,
  });
  assert.equal(
    (await required(observer.query("zerotrust.status", undefined))).accessReady,
    true,
  );
  await exerciseNativeAbsences(
    administrator,
    observer,
    owner,
    created.id,
    endpoints[1],
  );
  assert.ok(
    bodies.length > 20,
    "The wire observation must cover real RPC requests",
  );
  const wire = bodies.join("\n");
  for (const privateValue of [
    input.firstName,
    input.email,
    input.phone,
    String(input.costPerHour),
    "Vertrauliche Abwesenheitsnotiz 927184",
    "Vertraulicher Ablehnungsgrund 927184",
    password,
    invitation.link.secret,
  ]) {
    assert.equal(
      wire.includes(privateValue),
      false,
      "Only encrypted profiles and public invitation proofs may reach the API",
    );
  }
  console.log(
    "Native invitations verified: real personnel creation, reserved accounts, OPAQUE registration, browser-only secret verification, idempotent approval, independent-user private-field isolation and atomic deactivate/archive/reactivate across API replicas.",
  );
} finally {
  business?.dispose();
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  for (const client of [administrator, newcomer, observer]) {
    client.setToken(null);
  }
}

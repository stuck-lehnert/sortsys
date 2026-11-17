import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createClient,
  RpcClientError,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import { bytes, importSigningKey, sign, verify } from "@sortsys/zerotrust";
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
import {
  acceptVaultWithKey,
  lockCryptoSession,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { personnelCollection } from "../app/lib/data/personnelData";
import { PRODUCT_COLLECTION } from "../app/lib/data/products";
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
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const tenant = "member-deletion-tenant";
const ownerPassword = "Only-owner-knows-this-password-2026!";
const memberPassword = "Private-deleted-member-password-2026!";
const privateName = "Vertrauliches gelöschtes Personalprofil 549213";
const privateProduct = "Vertraulicher Artikel 871236";
const signal = new AbortController().signal;
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
const administrator = createClient(endpoints[0], "delete-administrator");
const peer = createClient(endpoints[1], "delete-peer-administrator");
const member = createClient(endpoints[1], "delete-member");
const memberPeer = createClient(endpoints[0], "delete-member-peer");
const clients = [administrator, peer, member, memberPeer];
type Batch = MutateInput<"zerotrust.objects.batch">;
type Mode =
  | "normal"
  | "discard"
  | "unsigned"
  | "partial"
  | "unbound"
  | "race"
  | "inventory-race"
  | "catalog-race"
  | "lose-reply";
let mode: Mode = "normal";
let captured: Batch | undefined;
let personId = "";
let concurrentPersonId = "";
let business: ReturnType<typeof createBusinessClient> | undefined;
let competitor: ReturnType<typeof createBusinessClient> | undefined;
const transport: Client = {
  ...administrator,
  query: (async (path, input, options) => {
    if (mode === "inventory-race" && path === "zerotrust.policy.get") {
      mode = "normal";
      const person = await required(
        competitor!.mutate("users.create", {
          username: "concurrent.dependent",
          firstName: "Zeitgleich angelegte Person 925764",
          contractType: "internal",
          supervisorUserId: personId,
        }),
      );
      concurrentPersonId = person.id;
    }
    return administrator.query(path, input, options);
  }) as Client["query"],
  mutate: (async (path, input, options) => {
    const batch = input as Batch;
    if (path !== "zerotrust.objects.batch" || batch.member?.action !== "delete")
      return administrator.mutate(path, input, options);
    captured = structuredClone(batch);
    if (mode === "discard") return [{ success: true, heads: [] }, null];
    if (mode === "unsigned") {
      return administrator.mutate(
        "zerotrust.objects.batch",
        { ...batch, member: { ...batch.member, proof: "" } },
        options,
      );
    }
    if (mode === "partial")
      return administrator.mutate(
        "zerotrust.objects.batch",
        { ...batch, objects: batch.objects.slice(0, 2) },
        options,
      );
    if (mode === "unbound") {
      const { member: _member, ...unbound } = batch;
      return administrator.mutate("zerotrust.objects.batch", unbound, options);
    }
    if (mode === "race") {
      mode = "normal";
      await required(
        competitor!.mutate("users.update", {
          id: personId,
          data: { firstName: privateName + " geändert" },
        }),
      );
    }
    if (mode === "catalog-race") {
      mode = "normal";
      const before = await required(
        peer.query("zerotrust.policy.get", undefined, {
          strategy: "network-only",
        }),
      );
      await required(
        competitor!.mutate("projects.create", {
          title: "Vertrauliches Parallelprojekt 531784",
        }),
      );
      const after = await required(
        peer.query("zerotrust.policy.get", undefined, {
          strategy: "network-only",
        }),
      );
      assert.equal(
        after.signature,
        before.signature,
        "This race must change the inventory without replacing the policy",
      );
    }
    const result = await administrator.mutate(path, input, options);
    if (mode === "lose-reply" && !result[1]) {
      mode = "normal";
      throw new Error("Lost response after atomic account deletion");
    }
    return result;
  }) as Client["mutate"],
};

try {
  console.log(
    "Native member deletion: preparing a real member, private profile and catalogue access",
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
  business = createBusinessClient(transport, { productDriver: duckDriver });
  competitor = createBusinessClient(peer, { productDriver: duckDriver });
  const person = await required(
    business.mutate("users.create", {
      username: "delete.member",
      firstName: privateName,
      costPerHour: 73.125,
      contractType: "external",
    }),
  );
  personId = person.id;
  const product = await required(
    business.mutate("products.create", {
      customId: 812346,
      name: privateProduct,
      baseUnit: "Stk",
    }),
  );
  const invitation = await createMemberInvitation(
    administrator,
    { id: personId, username: "delete.member" },
    {
      catalogue: "read",
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
  const historicalMessage = bytes(
    "Original signed decision retained after account deletion",
  );
  const historicalSignature = await sign(
    memberAccount.identity.signingKey.privateKey,
    historicalMessage,
  );
  await signIn(memberPeer, {
    tenant,
    username: "delete.member",
    password: memberPassword,
  });
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  await approveMemberInvitation(
    administrator,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  business.dispose();
  competitor.dispose();
  business = createBusinessClient(transport, { productDriver: duckDriver });
  competitor = createBusinessClient(peer, { productDriver: duckDriver });
  for (const client of [member, memberPeer]) {
    assert.ok(
      (
        await required(
          client.query(
            "zerotrust.objects.list",
            {
              domain: PRODUCT_COLLECTION.domain,
              prefix: PRODUCT_COLLECTION.prefix,
              after: null,
              snapshot: null,
            },
            { strategy: "network-only" },
          ),
        )
      ).objects.length > 0,
    );
  }
  const read = () =>
    required(
      business!.query(
        "users.get",
        { id: personId },
        { strategy: "network-only" },
      ),
    );
  const status = () =>
    required(
      administrator.query(
        "zerotrust.members.status",
        { id: personId },
        { strategy: "network-only" },
      ),
    );
  const original = await read();
  const masterArea = personnelCollection(personId, "master-data");
  const initialMaster = await protectedCollection(
    administrator,
    masterArea,
    signal,
  );
  let originalPayload: unknown;
  try {
    originalPayload = (await initialMaster.read())[0]!.value;
  } finally {
    initialMaster.close();
  }
  const initialStatus = await status();
  assert.equal(initialStatus.deletedMicros, null);

  console.log(
    "Native member deletion: direct and default supervisor references must be reassigned first",
  );
  const dependent = await required(
    business.mutate("users.create", {
      username: "dependent.member",
      firstName: "Abhängige Person 713482",
      contractType: "internal",
      supervisorUserId: personId,
    }),
  );
  const [, supervisionError] = await business.mutate("users.delete", {
    id: personId,
  });
  assert.match(supervisionError?.message ?? "", /Vorgesetzter/);
  assert.deepEqual(await read(), original);
  await required(
    business.mutate("users.update", {
      id: dependent.id,
      data: { supervisorUserId: ownerSession.user.id },
    }),
  );
  await required(
    business.mutate("users.supervisors.setDefault", { userId: personId }),
  );
  assert.ok((await business.mutate("users.delete", { id: personId }))[1]);
  assert.deepEqual(await read(), original);
  await required(
    business.mutate("users.supervisors.setDefault", { userId: null }),
  );

  console.log(
    "Native member deletion: a new personnel area between inventory and account checks invalidates the command",
  );
  mode = "inventory-race";
  assert.ok((await business.mutate("users.delete", { id: personId }))[1]);
  assert.notEqual(concurrentPersonId, "");
  assert.deepEqual(await read(), original);
  assert.equal((await status()).deletedMicros, null);
  await required(
    business.mutate("users.update", {
      id: concurrentPersonId,
      data: { supervisorUserId: ownerSession.user.id },
    }),
  );

  console.log(
    "Native member deletion: false acknowledgements, missing facets and missing account proofs never delete anything",
  );
  mode = "catalog-race";
  const [, catalogError] = await business.mutate("users.delete", {
    id: personId,
  });
  assert.ok(catalogError instanceof RpcClientError);
  assert.equal(catalogError.data?.code, "CONFLICT");
  assert.deepEqual(await read(), original);
  assert.equal((await status()).deletedMicros, null);
  for (const failure of [
    "discard",
    "unsigned",
    "partial",
    "unbound",
  ] as const) {
    mode = failure;
    assert.ok(
      (await business.mutate("users.delete", { id: personId }))[1],
      failure,
    );
    mode = "normal";
    assert.deepEqual(await read(), original);
    assert.equal((await status()).version, initialStatus.version);
    assert.equal((await status()).deletedMicros, null);
    await required(
      member.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
  }
  console.log(
    "Native member deletion: a concurrent profile edit rejects the entire stale deletion",
  );
  mode = "race";
  assert.ok((await business.mutate("users.delete", { id: personId }))[1]);
  assert.equal((await read()).firstName, privateName + " geändert");
  assert.equal((await status()).deletedMicros, null);
  assert.ok(
    (await business.mutate("users.delete", { id: ownerSession.user.id }))[1],
    "Self-deletion must be denied",
  );

  console.log(
    "Native member deletion: lost acknowledgement still confirms all tombstones and terminal account closure",
  );
  mode = "lose-reply";
  await required(business.mutate("users.delete", { id: personId }));
  const deleted = await status();
  assert.notEqual(deleted.deletedMicros, null);
  assert.ok(
    (
      await business.query(
        "users.get",
        { id: personId },
        { strategy: "network-only" },
      )
    )[1],
  );
  assert.equal(
    (
      await required(
        business.query(
          "users.list",
          { includeArchived: true },
          { strategy: "network-only" },
        ),
      )
    ).some((user) => user.id === personId),
    false,
  );
  assert.equal(
    (
      await required(
        administrator.query(
          "zerotrust.members.list",
          { after: null },
          { strategy: "network-only" },
        ),
      )
    ).rows.some((user) => user.id === personId),
    false,
  );
  for (const client of [member, memberPeer]) {
    assert.ok(
      (
        await client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        })
      )[1],
    );
    assert.ok(
      (
        await client.query(
          "zerotrust.objects.list",
          {
            domain: PRODUCT_COLLECTION.domain,
            prefix: PRODUCT_COLLECTION.prefix,
            after: null,
            snapshot: null,
          },
          { strategy: "network-only" },
        )
      )[1],
    );
  }
  assert.ok((await business.mutate("users.activate", { id: personId }))[1]);
  assert.ok(
    (
      await business.mutate("users.create", {
        username: "delete.member",
        firstName: "Reused alias",
      })
    )[1],
  );
  const history = await trustedHistory(administrator);
  const historicalIdentity = history.identityCertificate(
    memberAccount.vault.subject,
  );
  await verify(
    await importSigningKey(historicalIdentity.signingKey),
    historicalSignature,
    historicalMessage,
  );
  assert.ok(captured?.member);
  assert.equal(captured.objects.length, 3);
  assert.ok(
    captured.objects.every(
      (packet) => packet.envelope.format === "sortsys-object-tombstone-v1",
    ),
  );
  const removedMaster = captured.objects.find(
    (packet) => packet.domain === masterArea.domain,
  )!;
  const resurrect = await protectedCollection(
    administrator,
    masterArea,
    signal,
  );
  try {
    // Deliberately bypass the honest client's refusal to update a tombstone.
    // The resulting new ciphertext and account signature are otherwise valid.
    const packet = await resurrect.packet(masterArea.prefix, originalPayload, {
      ...removedMaster.envelope,
      format: "sortsys-object-v1",
    });
    const [, rejected] = await peer.mutate("zerotrust.objects.save", packet);
    assert.ok(rejected instanceof RpcClientError);
    assert.equal(
      rejected.data?.code,
      "FORBIDDEN",
      "The API must reject a signed attempt to restore the profile",
    );
    assert.equal((await status()).deletedMicros, deleted.deletedMicros);
  } finally {
    resurrect.close();
  }
  for (const client of [member, memberPeer]) {
    await assert.rejects(
      signIn(client, {
        tenant,
        username: "delete.member",
        password: memberPassword,
      }),
    );
  }

  console.log(
    "Native member deletion: a seed-only tenant recovery preserves the closed account and removed profiles",
  );
  business.dispose();
  competitor.dispose();
  const source = JSON.parse(
    await readFile(join(root, "owner-recovery.json"), "utf8"),
  );
  assert.equal(source.tenant, tenant);
  const draft = await recoveryDraft(
    administrator,
    tenant,
    source.phrase,
    "Recovered-owner-deletion-password-2026!",
  );
  const plan = await recoveryPlan(administrator, draft);
  await commitRecovery(administrator, plan);
  await signIn(administrator, {
    tenant,
    username: plan.username,
    password: draft.password,
  });
  assert.equal((await status()).deletedMicros, deleted.deletedMicros);
  business = createBusinessClient(administrator, { productDriver: duckDriver });
  assert.ok(
    (
      await business.query(
        "users.get",
        { id: personId },
        { strategy: "network-only" },
      )
    )[1],
  );
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    privateProduct,
  );
  assert.ok((await business.mutate("users.activate", { id: personId }))[1]);
  const transmitted = wire.join("\n");
  assert.ok(wire.length > 20);
  for (const secret of [
    privateName,
    privateProduct,
    memberPassword,
    ownerPassword,
    "73.125",
    draft.password,
    source.phrase,
  ]) {
    assert.equal(
      transmitted.includes(secret),
      false,
      "Business plaintext or passwords reached the API",
    );
  }
  await writeFile(
    outputPath,
    JSON.stringify({
      success: true,
      deletedMember: personId,
      terminalDeletion: true,
      rejectedPartialWrites: true,
      recoveryRetainedDeletion: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  business?.dispose();
  competitor?.dispose();
  await lockCryptoSession();
  for (const client of clients) client.setToken(null);
}

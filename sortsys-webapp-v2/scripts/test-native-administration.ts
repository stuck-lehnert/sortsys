import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  administrativeProfiles,
  administrativeProfileKey,
  compilePolicy,
  policyFrame,
  sign,
  signAdministrativePolicy,
  signPolicy,
  verifyPolicy,
  type Action,
  type SignedPolicy,
} from "@sortsys/zerotrust/sortsys";
import {
  administratorContext,
  administratorPolicyContext,
} from "../app/lib/crypto/administration";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
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
import {
  PRODUCT_COLLECTION,
  type ProductPayload,
} from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
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
const tenant = process.env.SORTSYS_NATIVE_AUTH_TENANT;
assert.equal(tenant, "administration-tenant");
const owner = createClient(endpoints[0], "administration-owner");
const manager = createClient(endpoints[1], "administration-manager");
const reader = createClient(endpoints[0], "administration-reader");
const signal = new AbortController().signal;
const login = {
  tenant,
  username: "builder",
  password: "Only-owner-knows-this-password-2026!",
};
const originalFetch = globalThis.fetch;
const bodies: string[] = [];
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") bodies.push(args[1].body);
    return Reflect.apply(target, receiver, args);
  },
});

async function enroll(client: Client, username: string) {
  console.log(`Native administration: enrolling ${username}`);
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  let person: { id: string };
  try {
    person = await required(
      business.mutate("users.create", {
        username,
        firstName: username,
        lastName: "Freigabetest",
      }),
    );
  } finally {
    business.dispose();
  }
  const invitation = await createMemberInvitation(
    owner,
    { id: person.id, username },
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
  const administrator = unlockedAccount()!;
  const password = `Private-password-${username}-2026!`;
  await signInMemberInvitation(client, invitation.link, password, signal);
  await joinMemberInvitation(client, invitation.link, signal);
  await acceptVaultWithKey(administrator.dataKey, administrator.vault, false);
  await approveMemberInvitation(
    owner,
    invitation.link.invitation.id,
    signal,
    duckDriver,
  );
  await signIn(client, { tenant: login.tenant, username, password });
  const account = unlockedAccount()!;
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  assert.equal(session.roles.includes(":admin"), false);
  await acceptVaultWithKey(administrator.dataKey, administrator.vault, false);
  return { subject: `user:${person.id}`, account };
}

try {
  await signIn(owner, login);
  await initializeTenant(owner, signal, duckDriver);
  const administrator = unlockedAccount()!;
  const delegated = await enroll(manager, "permission.manager");
  const employee = await enroll(reader, "permission.reader");
  const ownerBusiness = createBusinessClient(owner, {
    productDriver: duckDriver,
  });
  let product: { id: string };
  try {
    product = await required(
      ownerBusiness.mutate("products.create", {
        customId: 681942,
        name: "VERTRAULICHES_PRODUKT_681942",
        description: "VERTRAULICHE_BESCHREIBUNG_681942",
        baseUnit: "m",
      }),
    );
  } finally {
    ownerBusiness.dispose();
  }
  const primary = await administratorPolicyContext(owner, signal);
  const root = await signPolicy(
    {
      ...primary.permissions,
      version: (BigInt(primary.permissions.version) + 1n).toString(),
      rules: [
        ...primary.permissions.rules,
        {
          subject: delegated.subject,
          scope: PRODUCT_COLLECTION.scope,
          facet: PRODUCT_COLLECTION.facet,
          effect: "allow",
          actions: [...ACTIONS],
        },
        {
          subject: delegated.subject,
          scope: PRODUCT_COLLECTION.scope,
          facet: PRODUCT_COLLECTION.facet,
          effect: "deny",
          actions: ["delete"],
        },
      ],
    },
    primary.authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", root));

  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    false,
  );
  await assert.rejects(() => administratorContext(manager, signal));
  const access = await verifiedAccessContext(manager, signal, {
    includeDomains: false,
  });
  const author = access.history.identityCertificate(delegated.subject);
  const managerKey = unlockedAccount()!.identity.signingKey.privateKey;
  const authority = access.history.authority(access.history.current.generation);
  const managerRights = compilePolicy(access.permissions, [delegated.subject]);
  assert.equal(
    managerRights.allows(
      PRODUCT_COLLECTION.scope,
      PRODUCT_COLLECTION.facet,
      "grant",
    ),
    true,
  );
  assert.equal(
    managerRights.allows(
      PRODUCT_COLLECTION.scope,
      PRODUCT_COLLECTION.facet,
      "delete",
    ),
    false,
  );

  async function candidate(
    previous: SignedPolicy,
    actions: Action[],
    checkpoint = root,
  ) {
    const version = (BigInt(previous.version) + 1n).toString();
    const profile = await administrativeProfiles.sign(
      {
        tenant: login.tenant,
        rootSignature: checkpoint.signature,
        version,
        subject: employee.subject,
        scope: PRODUCT_COLLECTION.scope,
        facet: PRODUCT_COLLECTION.facet,
        actions,
        author,
      },
      managerKey,
    );
    const profiles = (previous.administration?.profiles ?? []).filter(
      (known) =>
        administrativeProfileKey(known) !== administrativeProfileKey(profile),
    );
    profiles.push(profile);
    profiles.sort((left, right) => {
      const first = administrativeProfileKey(left);
      const second = administrativeProfileKey(right);
      if (first === second) return 0;
      if (first < second) return -1;
      return 1;
    });
    return signAdministrativePolicy(
      {
        root: checkpoint,
        profiles,
        author,
        previousSignature: previous.signature,
        version,
      },
      managerKey,
    );
  }
  async function current(client: Client) {
    return required(
      client.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    );
  }
  async function rejected(client: Client, value: SignedPolicy) {
    const before = await current(client);
    const [result, error] = await client.mutate(
      "zerotrust.policy.replace",
      value,
    );
    assert.equal(result, null);
    assert.ok(error);
    assert.equal(
      (await current(client)).signature,
      before.signature,
      "A denied policy must leave the current state unchanged",
    );
  }
  async function edit(description: string, permitted: boolean) {
    await acceptVaultWithKey(
      employee.account.dataKey,
      employee.account.vault,
      false,
    );
    const business = createBusinessClient(reader, {
      productDriver: duckDriver,
    });
    try {
      const reply = await business.mutate("products.update", {
        id: product.id,
        data: { description },
      });
      if (permitted) await required(Promise.resolve(reply));
      else assert.ok(reply[1]);
    } finally {
      business.dispose();
    }
    await acceptVaultWithKey(
      delegated.account.dataKey,
      delegated.account.vault,
      false,
    );
  }

  await edit("VERBOTENE_AENDERUNG_681942", false);
  for (const actor of [
    {
      client: manager,
      certificate: author,
      identity: delegated.account.identity,
    },
    {
      client: reader,
      certificate: access.history.identityCertificate(employee.subject),
      identity: employee.account.identity,
    },
  ]) {
    const noChange = await signAdministrativePolicy(
      {
        root,
        profiles: [],
        author: actor.certificate,
        previousSignature: root.signature,
        version: (BigInt(root.version) + 1n).toString(),
      },
      actor.identity.signingKey.privateKey,
    );
    await verifyPolicy(noChange, { tenant: login.tenant, authority });
    await rejected(actor.client, noChange);
  }
  const writable = await candidate(root, ["read", "update"]);
  console.log(
    "Native administration: checking scoped delegation and forged requests",
  );
  await verifyPolicy(writable, { tenant: login.tenant, authority });
  await rejected(reader, writable);
  assert.ok(
    (
      await manager.query(
        "zerotrust.keys.get",
        { domain: "catalog:products:procurement", generation: "1" },
        { strategy: "network-only" },
      )
    )[1],
  );

  // Correct manager signatures must not make unauthorized profile contents valid.
  for (const patch of [
    { subject: `user:${primary.session.user.id}` },
    { facet: "procurement" as const },
    { actions: ["read", "delete"] as Action[] },
  ]) {
    const profile = await administrativeProfiles.sign(
      { ...writable.administration!.profiles[0]!, ...patch },
      managerKey,
    );
    const invalid = {
      ...writable,
      administration: { ...writable.administration!, profiles: [profile] },
    };
    const {
      signature: previousSignature,
      administration,
      ...permissions
    } = invalid;
    assert.ok(previousSignature);
    invalid.signature = await sign(
      managerKey,
      policyFrame(permissions, undefined, administration),
    );
    await rejected(manager, invalid);
  }
  await required(manager.mutate("zerotrust.policy.replace", writable));
  console.log(
    "Native administration: granting and revoking real product updates",
  );
  assert.equal((await current(owner)).signature, writable.signature);
  await edit("FREIGEGEBENE_AENDERUNG_681942", true);

  await acceptVaultWithKey(
    employee.account.dataKey,
    employee.account.vault,
    false,
  );
  const collection = await protectedCollection(
    reader,
    PRODUCT_COLLECTION,
    signal,
  );
  let delayed;
  let sequence: string;
  try {
    const original = (await collection.read()).find(
      (object) =>
        object.envelope.object === PRODUCT_COLLECTION.prefix + product.id,
    )!;
    const value = structuredClone(original.value) as ProductPayload;
    value.product.values.description = "VERZOEGERTER_SCHREIBAUFTRAG_681942";
    delayed = await collection.packet(
      original.envelope.object,
      value,
      original.envelope,
    );
    sequence = collection.snapshot();
  } finally {
    collection.close();
  }
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    false,
  );
  const readOnly = await candidate(writable, ["read"]);
  await required(manager.mutate("zerotrust.policy.replace", readOnly));
  const [, refusedWrite] = await reader.mutate("zerotrust.objects.batch", {
    objects: [delayed],
    heads: [{ domain: PRODUCT_COLLECTION.domain, sequence }],
  });
  assert.ok(
    refusedWrite,
    "A correctly encrypted write signed before revocation must be denied by the current policy",
  );
  await edit("VERBOTENE_AENDERUNG_NACH_ENTZUG_681942", false);
  await rejected(manager, writable);

  const rivals = await Promise.all([
    candidate(readOnly, ["read", "update"]),
    candidate(readOnly, ["read", "create"]),
  ]);
  console.log(
    "Native administration: concurrent policy replacement and primary revocation",
  );
  const replies = await Promise.all(
    rivals.map((value) => manager.mutate("zerotrust.policy.replace", value)),
  );
  assert.equal(replies.filter(([, error]) => !error).length, 1);
  assert.equal(replies.filter(([, error]) => error).length, 1);
  const winner = await current(manager);
  const retained = await candidate(winner, ["read", "update"]);
  await required(manager.mutate("zerotrust.policy.replace", retained));

  await acceptVaultWithKey(administrator.dataKey, administrator.vault, false);
  const effective = (
    await verifyPolicy(retained, { tenant: login.tenant, authority })
  ).permissions;
  const checkpoint = await signPolicy(
    {
      ...effective,
      version: (BigInt(retained.version) + 1n).toString(),
      rules: retained.rules
        .map((rule) => {
          if (rule.subject !== delegated.subject) return rule;
          return {
            ...rule,
            actions: rule.actions.filter((action) => action !== "grant"),
          };
        })
        .filter((rule) => rule.actions.length > 0),
    },
    primary.authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", checkpoint));
  assert.equal(
    checkpoint.administration,
    undefined,
    "A primary checkpoint must flatten profiles instead of growing a signature chain",
  );
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    false,
  );
  const stale = await candidate(checkpoint, ["read"]);
  await verifyPolicy(stale, { tenant: login.tenant, authority });
  await rejected(manager, stale);
  await edit("AENDERUNG_NACH_VERWALTERENTZUG_681942", true);
  assert.equal((await current(reader)).signature, checkpoint.signature);

  const wire = bodies.join("\n");
  for (const secret of [
    "VERTRAULICHES_PRODUKT_681942",
    "VERTRAULICHE_BESCHREIBUNG_681942",
    "FREIGEGEBENE_AENDERUNG_681942",
    "VERZOEGERTER_SCHREIBAUFTRAG_681942",
    "AENDERUNG_NACH_VERWALTERENTZUG_681942",
  ]) {
    assert.equal(
      wire.includes(secret),
      false,
      "Business plaintext must remain in the client",
    );
  }
  console.log(
    "Native administration verified: independent manager key, ordinary-user read/update changes, wrong actor/area/target denial, signed stale-write denial, competing policies and management revocation with retained employee rights across two APIs.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  for (const client of [owner, manager, reader]) {
    client.setToken(null);
  }
}

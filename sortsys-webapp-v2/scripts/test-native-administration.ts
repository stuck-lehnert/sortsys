import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  administrativeProfiles,
  administrativeProfileKey,
  compilePolicy,
  compileReadership,
  createManagedDomain,
  decryptObject,
  areaKey,
  openBox,
  keyAuthorityAuthor,
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
import { prepareHistoricalKeyGrants } from "../app/lib/crypto/historicalKeyGrants";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
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
const newReader = createClient(endpoints[1], "administration-new-reader");
const recoveryClients = endpoints.map((endpoint, index) =>
  createClient(endpoint, `administration-recovery-${index}`),
);
const clients = [owner, manager, reader, newReader, ...recoveryClients];
const recoverySecrets: string[] = [];
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

async function enroll(
  client: Client,
  username: string,
  catalogue: "read" | "none" = "read",
) {
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
      catalogue,
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
  const added = await enroll(newReader, "key.reader", "none");
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
  await changeAreaActionAccesses(
    owner,
    delegated.subject,
    [
      {
        area: PRODUCT_COLLECTION,
        patch: {
          read: true,
          create: true,
          update: true,
          delete: false,
          approve: true,
          grant: true,
        },
      },
    ],
    signal,
  );
  const root = await required(
    owner.query("zerotrust.policy.get", undefined, {
      strategy: "network-only",
    }),
  );
  const keyAuthority = await required(
    owner.query(
      "zerotrust.keyAuthorities.forArea",
      {
        scope: PRODUCT_COLLECTION.scope,
        facet: PRODUCT_COLLECTION.facet,
        holder: delegated.subject,
      },
      { strategy: "network-only" },
    ),
  );

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
  assert.equal(
    (
      await required(
        manager.query(
          "zerotrust.keyAuthorities.forArea",
          {
            scope: PRODUCT_COLLECTION.scope,
            facet: PRODUCT_COLLECTION.facet,
          },
          { strategy: "network-only" },
        ),
      )
    ).signature,
    keyAuthority.signature,
  );
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
    target = employee.subject,
  ) {
    const checkpoint = root;
    const version = (BigInt(previous.version) + 1n).toString();
    const profile = await administrativeProfiles.sign(
      {
        tenant: login.tenant,
        rootSignature: checkpoint.signature,
        version,
        subject: target,
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
  await changeAreaActionAccesses(
    manager,
    employee.subject,
    [{ area: PRODUCT_COLLECTION, patch: { update: true } }],
    signal,
  );
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
  await changeAreaActionAccesses(
    manager,
    employee.subject,
    [{ area: PRODUCT_COLLECTION, patch: { update: false } }],
    signal,
  );
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

  console.log(
    "Native administration: sharing history with a new reader and rotating keys without the primary key",
  );
  const initialGeneration = (
    await required(
      manager.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    )
  ).find((domain) => domain.id === PRODUCT_COLLECTION.domain)!.generation;
  const secondGeneration = (BigInt(initialGeneration) + 1n).toString();
  const thirdGeneration = (BigInt(secondGeneration) + 1n).toString();
  await acceptVaultWithKey(added.account.dataKey, added.account.vault, false);
  assert.ok(
    (
      await newReader.query(
        "zerotrust.keys.get",
        { domain: PRODUCT_COLLECTION.domain, generation: initialGeneration },
        { strategy: "network-only" },
      )
    )[1],
  );
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    false,
  );
  const shared = await candidate(retained, ["read"], added.subject);
  await required(manager.mutate("zerotrust.policy.replace", shared));
  const historical = await prepareHistoricalKeyGrants(manager, {
    area: {
      tenant: login.tenant,
      id: PRODUCT_COLLECTION.domain,
      scope: PRODUCT_COLLECTION.scope,
      facet: PRODUCT_COLLECTION.facet,
      generation: initialGeneration,
    },
    owner: {
      subject: delegated.subject,
      privateKey: delegated.account.identity.encryptionKey.privateKey,
    },
    authority: {
      generation: keyAuthority.generation,
      privateKey: managerKey,
      keyAuthority,
    },
    history: access.history.authority,
    readers: [
      {
        subject: added.subject,
        identity: access.history.identityCertificate(added.subject),
      },
    ],
    signal,
  });
  assert.equal(historical.length, Number(initialGeneration));
  async function rotation(policy: SignedPolicy, generation: string) {
    const checked = (
      await verifyPolicy(policy, { tenant: login.tenant, authority })
    ).permissions;
    return createManagedDomain({
      tenant: login.tenant,
      id: PRODUCT_COLLECTION.domain,
      scope: PRODUCT_COLLECTION.scope,
      facet: PRODUCT_COLLECTION.facet,
      generation,
      policyVersion: policy.version,
      keyAuthority,
      signingKey: managerKey,
      recovery: {
        encryptionKey: access.history.current.recoveryEncryptionKey,
        signingKey: access.history.current.recoverySigningKey,
      },
      readers: compileReadership(checked)(
        PRODUCT_COLLECTION.scope,
        PRODUCT_COLLECTION.facet,
      ).map((subject) => ({
        subject,
        identity: access.history.identityCertificate(subject),
      })),
    });
  }
  const proposed = await rotation(shared, secondGeneration);
  assert.ok(
    (await reader.mutate("zerotrust.domains.put", proposed.definition))[1],
  );
  assert.ok(
    (
      await reader.query(
        "zerotrust.keys.inspect",
        {
          keys: [
            {
              domain: PRODUCT_COLLECTION.domain,
              generation: initialGeneration,
              recipient: `user:${primary.session.user.id}`,
            },
          ],
        },
        { strategy: "network-only" },
      )
    )[1],
  );
  assert.ok(
    (
      await manager.mutate("zerotrust.keys.grant", {
        domain: historical[0]!.domain,
        generation: historical[0]!.generation,
        envelope: historical[0]!.envelope,
      })
    )[1],
    "A delegated signature without its authority proof cannot use the primary-administrator path",
  );
  const substituted = structuredClone(historical[0]!);
  substituted.envelope.recipient = employee.subject;
  assert.ok(
    (
      await manager.mutate("zerotrust.access.publish", {
        policyVersion: shared.version,
        grants: [historical[0]!, substituted],
        domains: [],
      })
    )[1],
  );
  const [partial, failedGrant] = await newReader.query(
    "zerotrust.keys.get",
    {
      domain: PRODUCT_COLLECTION.domain,
      generation: historical[0]!.generation,
    },
    { strategy: "network-only" },
  );
  assert.equal(partial, null);
  assert.ok(
    failedGrant,
    "A later invalid grant must roll back the earlier valid recipient copy",
  );
  // The signed profile already exists, as after an interrupted command. The
  // production action must finish its keys without another policy revision.
  await changeAreaActionAccesses(
    manager,
    added.subject,
    [{ area: PRODUCT_COLLECTION, patch: { read: true } }],
    signal,
  );
  assert.equal((await current(manager)).signature, shared.signature);
  const second = {
    definition: await required(
      manager.query(
        "zerotrust.domains.get",
        {
          domain: PRODUCT_COLLECTION.domain,
          generation: secondGeneration,
        },
        { strategy: "network-only" },
      ),
    ),
  };
  await acceptVaultWithKey(added.account.dataKey, added.account.vault, false);
  const addedBusiness = createBusinessClient(newReader, {
    productDriver: duckDriver,
  });
  try {
    const visible = await required(
      addedBusiness.query("products.get", { id: product.id }),
    );
    assert.equal(visible.description, "FREIGEGEBENE_AENDERUNG_681942");
  } finally {
    addedBusiness.dispose();
  }
  const oldEnvelope = second.definition.envelopes.find(
    (envelope) => envelope.recipient === added.subject,
  )!;
  const oldRaw = await openBox(
    oldEnvelope,
    {
      tenant: login.tenant,
      purpose: "area-key",
      object: PRODUCT_COLLECTION.domain,
      generation: secondGeneration,
      recipient: added.subject,
      author: keyAuthorityAuthor(keyAuthority),
    },
    added.account.identity.encryptionKey.privateKey,
    delegated.account.identity.signingKey.publicKey,
  );
  const oldKey = await areaKey(oldRaw);
  oldRaw.fill(0);
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    false,
  );
  const revoked = await candidate(shared, [], added.subject);
  await required(manager.mutate("zerotrust.policy.replace", revoked));
  await changeAreaActionAccesses(
    manager,
    added.subject,
    [{ area: PRODUCT_COLLECTION, patch: { read: false } }],
    signal,
  );
  assert.equal((await current(manager)).signature, revoked.signature);
  const third = {
    definition: await required(
      manager.query(
        "zerotrust.domains.get",
        {
          domain: PRODUCT_COLLECTION.domain,
          generation: thirdGeneration,
        },
        { strategy: "network-only" },
      ),
    ),
  };
  const managerBusiness = createBusinessClient(manager, {
    productDriver: duckDriver,
  });
  try {
    await required(
      managerBusiness.mutate("products.update", {
        id: product.id,
        data: { description: "NEUE_SCHLUESSELGENERATION_681942" },
      }),
    );
  } finally {
    managerBusiness.dispose();
  }
  const changed = await required(
    manager.query(
      "zerotrust.objects.get",
      { id: PRODUCT_COLLECTION.prefix + product.id },
      { strategy: "network-only" },
    ),
  );
  assert.equal(changed.generation, thirdGeneration);
  const {
    format,
    nonce,
    ciphertext,
    wrappedKey,
    signature,
    ...changedContext
  } = changed;
  assert.ok(format && nonce && ciphertext && wrappedKey && signature);
  await assert.rejects(() =>
    decryptObject(
      changed,
      changedContext,
      oldKey,
      delegated.account.identity.signingKey.publicKey,
    ),
  );
  assert.ok(
    (
      await newReader.query(
        "zerotrust.keys.get",
        { domain: PRODUCT_COLLECTION.domain, generation: thirdGeneration },
        { strategy: "network-only" },
      )
    )[1],
  );

  await acceptVaultWithKey(administrator.dataKey, administrator.vault, false);
  const effective = (
    await verifyPolicy(revoked, { tenant: login.tenant, authority })
  ).permissions;
  const checkpoint = await signPolicy(
    {
      ...effective,
      version: (BigInt(revoked.version) + 1n).toString(),
      rules: revoked.rules
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
  const future = await rotation(
    checkpoint,
    (BigInt(thirdGeneration) + 1n).toString(),
  );
  assert.ok(
    (
      await manager.query(
        "zerotrust.keyAuthorities.forArea",
        {
          scope: PRODUCT_COLLECTION.scope,
          facet: PRODUCT_COLLECTION.facet,
        },
        { strategy: "network-only" },
      )
    )[1],
  );
  assert.ok(
    (await manager.mutate("zerotrust.domains.put", future.definition))[1],
  );
  assert.ok(
    (
      await manager.mutate("zerotrust.access.publish", {
        policyVersion: checkpoint.version,
        grants: historical,
        domains: [],
      })
    )[1],
  );
  assert.equal(
    (
      await required(
        manager.query(
          "zerotrust.domains.get",
          { domain: PRODUCT_COLLECTION.domain, generation: thirdGeneration },
          { strategy: "network-only" },
        ),
      )
    ).proof,
    third.definition.proof,
  );
  await edit("AENDERUNG_NACH_VERWALTERENTZUG_681942", true);
  assert.equal((await current(reader)).signature, checkpoint.signature);

  const testRoot = process.env.SORTSYS_NATIVE_AUTH_ROOT;
  assert.ok(testRoot);
  const recoverySource: { tenant: string; phrase: string } = JSON.parse(
    await readFile(join(testRoot, "owner-recovery.json"), "utf8"),
  );
  assert.equal(recoverySource.tenant, tenant);
  let phrase = recoverySource.phrase;
  recoverySecrets.push(phrase);
  for (let round = 0; round < 2; round++) {
    console.log(`Native administration: seed-only recovery ${round + 1}`);
    await lockCryptoSession();
    for (const client of clients) client.setToken(null);
    assert.equal(unlockedAccount(), null);
    const client = recoveryClients[round]!;
    const other = recoveryClients[1 - round]!;
    const password = `Independent-seed-recovery-${round}-2026!`;
    const draft = await recoveryDraft(client, tenant, phrase, password);
    recoverySecrets.push(password, draft.newPhrase);
    const plan = await recoveryPlan(client, draft);
    await commitRecovery(client, plan);
    await assert.rejects(() => recoveryDraft(other, tenant, phrase, password));
    await signIn(client, { tenant, username: plan.username, password });
    const initialized = await initializeTenant(client, signal, duckDriver);
    assert.equal(initialized.generation, String(round + 2));
    const recoveredBusiness = createBusinessClient(client, {
      productDriver: duckDriver,
    });
    try {
      const restored = await required(
        recoveredBusiness.query("products.get", { id: product.id }),
      );
      assert.equal(
        restored.description,
        "AENDERUNG_NACH_VERWALTERENTZUG_681942",
      );
    } finally {
      recoveredBusiness.dispose();
    }
    phrase = draft.newPhrase;
  }

  const wire = bodies.join("\n");
  for (const secret of [
    "VERTRAULICHES_PRODUKT_681942",
    "VERTRAULICHE_BESCHREIBUNG_681942",
    "FREIGEGEBENE_AENDERUNG_681942",
    "VERZOEGERTER_SCHREIBAUFTRAG_681942",
    "AENDERUNG_NACH_VERWALTERENTZUG_681942",
    "NEUE_SCHLUESSELGENERATION_681942",
    ...recoverySecrets,
  ]) {
    assert.equal(
      wire.includes(secret),
      false,
      "Business plaintext must remain in the client",
    );
  }
  console.log(
    "Native administration verified: independent manager key, atomic historical grants and rotation, wrong actor/area/target denial, stale-write denial, competing policies, management revocation and two seed-only recoveries across two APIs.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  for (const client of clients) {
    client.setToken(null);
  }
}

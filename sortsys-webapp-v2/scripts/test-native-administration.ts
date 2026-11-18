import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import {
  createClient,
  RpcClientError,
  type Client,
  type QueryInput,
} from "@sortsys/v2-client";
import {
  administrativeProfiles,
  administrativeProfileKey,
  base64,
  compilePolicy,
  compileReadership,
  contentEpoch,
  contentEpochFingerprint,
  createManagedDomain,
  decryptObject,
  areaKey,
  openBox,
  keyAuthorityAuthor,
  policyFrame,
  sign,
  signAdministrativePolicy,
  signPolicy,
  signPolicyContinuation,
  randomSecret,
  verifyPolicy,
  type Action,
  type SignedPolicy,
} from "@sortsys/zerotrust/sortsys";
import {
  administratorContext,
  administratorPolicyContext,
} from "../app/lib/crypto/administration";
import { verifiedAccessContext } from "../app/lib/crypto/accessContext";
import {
  approvePreparedContent,
  inspectPreparedContent,
} from "../app/lib/backups/contentRestore";
import { prepareHistoricalKeyGrants } from "../app/lib/crypto/historicalKeyGrants";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  changeAreaActionAccesses,
  shareNewPersonnelName,
} from "../app/lib/crypto/permissions";
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
  productPayload,
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
const originalFetch = globalThis.fetch;
const bodies: string[] = [];
const transmissions: string[][] = [];
// Install before constructing clients: the transport captures fetch at setup.
// Observe query inputs as well as request bodies, so a GET cannot evade the
// plaintext canaries checked below.
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const requestUrl =
      args[0] instanceof Request ? args[0].url : String(args[0]);
    const url = new URL(requestUrl);
    transmissions.push(url.pathname.split("/").at(-1)!.split(","));
    for (const value of url.searchParams.values()) bodies.push(value);
    if (typeof args[1]?.body === "string") bodies.push(args[1].body);
    return Reflect.apply(target, receiver, args);
  },
});
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

async function recoverInBrowser(
  phrase: string,
  password: string,
  username: string,
): Promise<string> {
  const child = spawn("node", ["scripts/e2e/seedRecovery.browser.mjs"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      SORTSYS_RECOVERY_E2E_PHRASE: phrase,
      SORTSYS_RECOVERY_E2E_PASSWORD: password,
      SORTSYS_RECOVERY_E2E_USER: username,
    },
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, termination) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Seed recovery browser test failed: ${termination ?? code}`,
          ),
        );
    });
  });
  // Carry the replacement phrase to the second recovery in memory only.
  const [output] = await Promise.all([text(child.stdout), finished]);
  const newPhrase: unknown = JSON.parse(output);
  assert.ok(
    typeof newPhrase === "string" && newPhrase.split(" ").length === 24,
  );
  assert.ok(newPhrase !== phrase);
  return newPhrase;
}

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
  await shareNewPersonnelName(owner, person.id, signal);
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
  await signIn(client, { tenant: login.tenant, username, password });
  const account = unlockedAccount()!;
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  assert.equal(session.roles.includes(":admin"), false);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  return { subject: `user:${person.id}`, account, password };
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
  if (
    process.env.SORTSYS_NATIVE_ADMIN_UI === "1" ||
    process.env.SORTSYS_NATIVE_BROWSER === "1"
  ) {
    const testRoot = process.env.SORTSYS_NATIVE_AUTH_ROOT;
    assert.ok(testRoot);
    const log = join(testRoot, "browser-administration-ui.log");
    const output = await open(log, "w");
    try {
      const child = spawn("node", ["scripts/e2e/scopedAccess.browser.mjs"], {
        env: process.env,
        stdio: ["ignore", output.fd, output.fd],
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Scoped administration browser test failed; inspect ${log}`,
              ),
            );
        });
      });
    } finally {
      await output.close();
    }
  }
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
    delegated.account.username,
    false,
  );
  await assert.rejects(() => administratorContext(manager, signal));
  const access = await verifiedAccessContext(manager, signal, {
    includeDomains: false,
  });
  const author = access.history.identityCertificate(delegated.subject);
  const managerKey = unlockedAccount()!.identity.signingKey.privateKey;
  const recipients = await required(
    manager.query(
      "zerotrust.identities.recipients",
      {
        scope: PRODUCT_COLLECTION.scope,
        facet: PRODUCT_COLLECTION.facet,
        after: null,
      },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(Object.keys(recipients).sort(), ["after", "rows"]);
  assert.ok(recipients.rows.includes(employee.subject.slice(5)));
  assert.ok(recipients.rows.includes(added.subject.slice(5)));
  for (const actor of [reader, newReader]) {
    const [directory, denied] = await actor.query(
      "zerotrust.identities.recipients",
      {
        scope: PRODUCT_COLLECTION.scope,
        facet: PRODUCT_COLLECTION.facet,
        after: null,
      },
      { strategy: "network-only" },
    );
    assert.equal(directory, null);
    assert.equal(denied?.code, "FORBIDDEN");
  }
  const [, unrelatedDirectory] = await manager.query(
    "zerotrust.identities.recipients",
    {
      scope: PRODUCT_COLLECTION.scope,
      facet: "procurement",
      after: null,
    },
    { strategy: "network-only" },
  );
  assert.equal(unrelatedDirectory?.code, "FORBIDDEN");
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
  const managedArea = {
    scope: PRODUCT_COLLECTION.scope,
    facet: PRODUCT_COLLECTION.facet,
  };
  const certificates = await required(
    manager.query(
      "zerotrust.keyAuthorities.forAreas",
      { areas: [managedArea] },
      { strategy: "network-only" },
    ),
  );
  assert.equal(certificates.length, 1);
  assert.equal(certificates[0]?.signature, keyAuthority.signature);
  const deniedBatches: Array<{
    areas: QueryInput<"zerotrust.keyAuthorities.forAreas">["areas"];
    code: "BAD_REQUEST" | "FORBIDDEN";
  }> = [
    { areas: [], code: "BAD_REQUEST" },
    { areas: [managedArea, managedArea], code: "BAD_REQUEST" },
    {
      areas: Array.from({ length: 33 }, () => managedArea),
      code: "BAD_REQUEST",
    },
    {
      areas: [managedArea, { ...managedArea, facet: "calculation" }],
      code: "FORBIDDEN",
    },
    {
      areas: [managedArea, { ...managedArea, holder: employee.subject }],
      code: "FORBIDDEN",
    },
  ];
  for (const { areas, code } of deniedBatches) {
    const [partial, denied] = await manager.query(
      "zerotrust.keyAuthorities.forAreas",
      { areas },
      { strategy: "network-only" },
    );
    assert.equal(
      partial,
      null,
      "A denied batch must never return partial certificates",
    );
    assert.ok(denied);
    assert.equal(denied.code, code);
  }
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
      employee.account.username,
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
      delegated.account.username,
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
    employee.account.username,
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
    delegated.account.username,
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
  const selectedGenerations =
    initialGeneration === "1" ? ["1"] : [initialGeneration, "1"];
  const historyKeys = await required(
    manager.query(
      "zerotrust.keys.history",
      { domain: PRODUCT_COLLECTION.domain, generations: selectedGenerations },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(
    historyKeys.map((entry) => entry.generation),
    selectedGenerations,
  );
  for (const entry of historyKeys) {
    const [definition, envelope] = await Promise.all([
      required(
        manager.query(
          "zerotrust.domains.get",
          {
            domain: PRODUCT_COLLECTION.domain,
            generation: entry.generation,
          },
          { strategy: "network-only" },
        ),
      ),
      required(
        manager.query(
          "zerotrust.keys.get",
          {
            domain: PRODUCT_COLLECTION.domain,
            generation: entry.generation,
          },
          { strategy: "network-only" },
        ),
      ),
    ]);
    assert.deepEqual(entry.definition, definition);
    assert.deepEqual(entry.envelope, envelope);
  }
  for (const generations of [
    [],
    ["01"],
    ["1", "1"],
    Array.from({ length: 17 }, (_, index) => String(index + 1)),
    ["1", thirdGeneration],
  ]) {
    const [partial, invalidHistory] = await manager.query(
      "zerotrust.keys.history",
      {
        domain: PRODUCT_COLLECTION.domain,
        generations,
      },
      { strategy: "network-only" },
    );
    assert.equal(partial, null);
    assert.ok(
      invalidHistory,
      "An invalid or unavailable generation rejects the entire history selection",
    );
  }
  const [hiddenHistory, deniedHistory] = await newReader.query(
    "zerotrust.keys.history",
    {
      domain: PRODUCT_COLLECTION.domain,
      generations: ["1"],
    },
    { strategy: "network-only" },
  );
  assert.equal(hiddenHistory, null);
  assert.equal(deniedHistory?.code, "FORBIDDEN");
  console.log(
    "Native key history: bounded selections retain exact definition/key pairs and reject partial, duplicate, unavailable or unauthorized reads",
  );
  await acceptVaultWithKey(
    added.account.dataKey,
    added.account.vault,
    added.account.username,
    false,
  );
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
    delegated.account.username,
    false,
  );
  const shared = await candidate(retained, ["read"], added.subject);
  await required(manager.mutate("zerotrust.policy.replace", shared));
  const missingCopy = await required(
    newReader.query(
      "zerotrust.keys.history",
      {
        domain: PRODUCT_COLLECTION.domain,
        generations: [initialGeneration],
      },
      { strategy: "network-only" },
    ),
  );
  assert.equal(missingCopy.length, 1);
  assert.equal(
    missingCopy[0]!.envelope,
    null,
    "Current read permission does not manufacture a missing historical key copy",
  );
  const historyStart = transmissions.length;
  const historical = await prepareHistoricalKeyGrants(manager, {
    // The optional browser phase may already have granted a generation.
    // Refresh all historical copies for the atomic replacement checks below.
    replaceExisting: true,
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
  assert.equal(
    transmissions
      .slice(historyStart)
      .filter((paths) => paths.includes("zerotrust.keys.history")).length,
    Math.ceil(Number(initialGeneration) / 16),
    "Historical definitions and recipient copies share one HTTP read per 16 generations",
  );
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
  const [previousCopy] = await newReader.query(
    "zerotrust.keys.get",
    {
      domain: PRODUCT_COLLECTION.domain,
      generation: historical[0]!.generation,
    },
    { strategy: "network-only" },
  );
  assert.notDeepEqual(previousCopy, historical[0]!.envelope);
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
  assert.deepEqual(
    partial,
    previousCopy,
    "A later invalid grant must leave the previous recipient copy unchanged",
  );
  if (previousCopy === null) {
    assert.ok(failedGrant);
  } else {
    assert.equal(failedGrant, null);
  }
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
  await acceptVaultWithKey(
    added.account.dataKey,
    added.account.vault,
    added.account.username,
    false,
  );
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
    delegated.account.username,
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

  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const operator = createClient(endpoints[1], "administration-restore-storage");
  const storageLogin = await required(
    operator.mutate("admin.login", {
      tenant: null,
      password: "Disposable-operator-password-2026!",
    }),
  );
  operator.setToken(storageLogin.token);
  const backup = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  operator.setToken(null);
  await edit("AENDERUNG_NACH_SICHERUNG_681942", true);
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const prepared = await required(
    owner.mutate("zerotrust.content.prepare", {
      operation: crypto.randomUUID(),
      snapshotOperation: backup.id,
    }),
  );
  const proposal = await approvePreparedContent(owner, prepared, signal);
  const reviewed = await inspectPreparedContent(owner, proposal, signal);
  const restore = { ...proposal, review: reviewed.review };
  const restoredContent = await contentEpochFingerprint(
    contentEpoch(restore.approval),
  );
  const beforeRestore = await verifyPolicy(revoked, { tenant, authority });
  assert.deepEqual(
    restore.policy.administration?.profiles,
    revoked.administration?.profiles,
  );
  const stripped = await signPolicy(
    { ...beforeRestore.permissions, version: restore.policy.version },
    primary.authority,
  );
  const differentContent = await signPolicyContinuation(
    revoked,
    base64(randomSecret()),
    primary.authority,
  );
  const alternative = await signAdministrativePolicy(
    {
      ...revoked.administration!,
      previousSignature: revoked.signature,
      version: revoked.version,
    },
    managerKey,
  );
  const differentPolicy = await signPolicyContinuation(
    alternative,
    restoredContent,
    primary.authority,
  );
  for (const invalidPolicy of [stripped, differentContent, differentPolicy]) {
    const [value, denial] = await owner.mutate("zerotrust.content.activate", {
      ...restore,
      policy: invalidPolicy,
    });
    assert.equal(value, null);
    assert.ok(denial instanceof RpcClientError);
    assert.equal(denial.code, "FORBIDDEN");
  }
  assert.equal((await current(owner)).signature, revoked.signature);
  const [managerActivation, managerDenial] = await manager.mutate(
    "zerotrust.content.activate",
    restore,
  );
  assert.equal(managerActivation, null);
  assert.ok(managerDenial instanceof RpcClientError);
  assert.equal(managerDenial.code, "FORBIDDEN");
  const signed = await verifyPolicy(restore.policy, { tenant, authority });
  const { permissions: restoredPermissions, ...restoredEvidence } = signed;
  const continued = { ...restoredPermissions, ...restoredEvidence };
  await rejected(owner, continued);
  const publication = await required(
    owner.mutate("zerotrust.content.activate", restore),
  );
  assert.equal(publication.content, restoredContent);
  assert.equal((await current(manager)).signature, continued.signature);
  const restoredBusiness = createBusinessClient(owner, {
    productDriver: duckDriver,
  });
  try {
    const productAfter = await required(
      restoredBusiness.query("products.get", { id: product.id }),
    );
    assert.equal(productAfter.description, "NEUE_SCHLUESSELGENERATION_681942");
  } finally {
    restoredBusiness.dispose();
  }
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    delegated.account.username,
    false,
  );
  const regranted = await candidate(continued, ["read"], added.subject);
  await required(manager.mutate("zerotrust.policy.replace", regranted));
  const restoredRevocation = await candidate(regranted, [], added.subject);
  await required(
    manager.mutate("zerotrust.policy.replace", restoredRevocation),
  );
  assert.equal((await current(owner)).signature, restoredRevocation.signature);
  console.log(
    "Native content restore preserved scoped profiles and their subsequent grant and revocation",
  );
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const effective = (
    await verifyPolicy(restoredRevocation, { tenant: login.tenant, authority })
  ).permissions;
  const checkpoint = await signPolicy(
    {
      ...effective,
      version: (BigInt(restoredRevocation.version) + 1n).toString(),
      rules: restoredRevocation.rules
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
    delegated.account.username,
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

  // Re-establish a scoped manager through the normal client before restoring
  // again. The recovery must begin with a continued policy still active.
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  await changeAreaActionAccesses(
    owner,
    delegated.subject,
    [{ area: PRODUCT_COLLECTION, patch: { grant: true } }],
    signal,
  );
  await acceptVaultWithKey(
    delegated.account.dataKey,
    delegated.account.vault,
    delegated.account.username,
    false,
  );
  await changeAreaActionAccesses(
    manager,
    added.subject,
    [{ area: PRODUCT_COLLECTION, patch: { read: true } }],
    signal,
  );
  const delegatedBeforeRecovery = await current(owner);
  assert.ok(
    delegatedBeforeRecovery.administration?.profiles.some(
      (profile) => profile.subject === added.subject,
    ),
  );
  await acceptVaultWithKey(
    administrator.dataKey,
    administrator.vault,
    administrator.username,
    false,
  );
  const preparedForRecovery = await required(
    owner.mutate("zerotrust.content.prepare", {
      snapshotOperation: backup.id,
      operation: crypto.randomUUID(),
    }),
  );
  const restoreForRecovery = await approvePreparedContent(
    owner,
    preparedForRecovery,
    signal,
  );
  assert.deepEqual(
    restoreForRecovery.policy.administration?.profiles,
    delegatedBeforeRecovery.administration?.profiles,
  );
  const recoveryReview = await inspectPreparedContent(
    owner,
    restoreForRecovery,
    signal,
  );
  await required(
    owner.mutate("zerotrust.content.activate", {
      ...restoreForRecovery,
      review: recoveryReview.review,
    }),
  );
  const policyAtRecovery = await current(manager);
  assert.ok(policyAtRecovery.administration?.continuation);
  assert.equal(policyAtRecovery.signature, restoreForRecovery.policy.signature);
  const oldOwner = await required(owner.query("auth.sessionInfo", undefined));

  async function readOnlyProduct() {
    const catalogue = await protectedCollection(
      newReader,
      PRODUCT_COLLECTION,
      signal,
    );
    try {
      const productAfter = await catalogue.get(
        PRODUCT_COLLECTION.prefix + product.id,
      );
      const payload = productPayload(
        productAfter.value,
        productAfter.envelope.object,
      );
      assert.equal(
        payload.product?.values.description,
        "NEUE_SCHLUESSELGENERATION_681942",
      );
      assert.equal(catalogue.can("update"), false);
      assert.equal(catalogue.can("delete"), false);
    } finally {
      catalogue.close();
    }
  }

  await acceptVaultWithKey(
    added.account.dataKey,
    added.account.vault,
    added.account.username,
    false,
  );
  await readOnlyProduct();

  const testRoot = process.env.SORTSYS_NATIVE_AUTH_ROOT;
  assert.ok(testRoot);
  const recoverySource: { tenant: string; phrase: string } = JSON.parse(
    await readFile(join(testRoot, "owner-recovery.json"), "utf8"),
  );
  assert.equal(recoverySource.tenant, tenant);
  let phrase = recoverySource.phrase;
  const spentPhrases: string[] = [];
  recoverySecrets.push(phrase);
  for (let round = 0; round < 2; round++) {
    console.log(`Native administration: seed-only recovery ${round + 1}`);
    await lockCryptoSession();
    for (const client of clients) {
      if (client !== manager) client.setToken(null);
    }
    assert.equal(unlockedAccount(), null);
    const client = recoveryClients[round]!;
    const other = recoveryClients[1 - round]!;
    const password = `Independent-seed-recovery-${round}-2026!`;
    const username = oldOwner.user.username;
    let nextPhrase: string;
    if (round === 0 && process.env.SORTSYS_NATIVE_BROWSER === "1") {
      nextPhrase = await recoverInBrowser(phrase, password, username);
    } else {
      const draft = await recoveryDraft(client, tenant, phrase, password, {
        restoreAdministrator: true,
      });
      const plan = await recoveryPlan(client, draft);
      assert.equal(plan.username, username);
      await commitRecovery(client, plan);
      nextPhrase = draft.newPhrase;
    }
    recoverySecrets.push(password, nextPhrase);
    spentPhrases.push(phrase);
    for (const spent of spentPhrases) {
      await assert.rejects(() => recoveryDraft(other, tenant, spent, password));
    }
    if (round === 0) {
      const [oldGrant, oldGrantError] = await manager.query(
        "zerotrust.keys.get",
        { domain: PRODUCT_COLLECTION.domain, generation: thirdGeneration },
        { strategy: "network-only" },
      );
      assert.equal(oldGrant, null);
      assert.ok(
        oldGrantError,
        "An old manager session must not get a key after recovery",
      );
      manager.setToken(null);
    }
    await signIn(client, { tenant, username, password });
    const session = await required(client.query("auth.sessionInfo", undefined));
    assert.equal(session.user.id, oldOwner.user.id);
    assert.equal(session.user.username, oldOwner.user.username);
    assert.ok(session.roles.includes(":admin"));
    const initialized = await initializeTenant(client, signal, duckDriver);
    assert.equal(initialized.generation, String(round + 2));
    const recoveredPolicy = await current(client);
    assert.equal(
      recoveredPolicy.administration,
      undefined,
      "Historical delegated signatures do not authorize current grants after recovery",
    );
    const historicalPolicy = await required(
      client.query(
        "zerotrust.policy.getVersion",
        { version: policyAtRecovery.version },
        {
          strategy: "network-only",
        },
      ),
    );
    assert.equal(historicalPolicy.generation, "1");
    assert.deepEqual(historicalPolicy.policy, policyAtRecovery);
    await verifyPolicy(historicalPolicy.policy, { tenant, authority });
    const recoveredBusiness = createBusinessClient(client, {
      productDriver: duckDriver,
    });
    try {
      const restored = await required(
        recoveredBusiness.query("products.get", { id: product.id }),
      );
      assert.equal(restored.description, "NEUE_SCHLUESSELGENERATION_681942");
    } finally {
      recoveredBusiness.dispose();
    }
    await signIn(newReader, {
      tenant,
      username: added.account.username,
      password: added.password,
    });
    await assert.rejects(() =>
      protectedCollection(newReader, PRODUCT_COLLECTION, signal),
    );
    if (round === 0) {
      await signIn(client, {
        tenant,
        username: oldOwner.user.username,
        password,
      });
      const invitation = await createMemberInvitation(
        client,
        { id: added.subject.slice(5), username: added.account.username },
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
      await signInMemberInvitation(
        newReader,
        invitation.link,
        added.password,
        signal,
      );
      await joinMemberInvitation(newReader, invitation.link, signal);
      await signIn(client, {
        tenant,
        username: oldOwner.user.username,
        password,
      });
      await approveMemberInvitation(
        client,
        invitation.link.invitation.id,
        signal,
        duckDriver,
      );
      await signIn(newReader, {
        tenant,
        username: added.account.username,
        password: added.password,
      });
      await readOnlyProduct();
    }
    phrase = nextPhrase;
  }

  const wire = bodies.join("\n");
  assert.ok(
    wire.includes("sortsys-hpke-v1"),
    "The leak check must have observed actual encrypted RPC payloads",
  );
  for (const secret of [
    "VERTRAULICHES_PRODUKT_681942",
    "VERTRAULICHE_BESCHREIBUNG_681942",
    "FREIGEGEBENE_AENDERUNG_681942",
    "VERZOEGERTER_SCHREIBAUFTRAG_681942",
    "AENDERUNG_NACH_VERWALTERENTZUG_681942",
    "NEUE_SCHLUESSELGENERATION_681942",
    "AENDERUNG_NACH_SICHERUNG_681942",
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

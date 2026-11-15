import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createClient,
  type Client,
  type MutateInput,
} from "@sortsys/v2-client";
import { createRecoveryPhrase } from "@sortsys/zerotrust/sortsys";
import {
  lockCryptoSession,
  signIn,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
} from "../app/lib/crypto/recovery";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  newAssistantId,
  openPrivateLlm,
  preparePrivateLlm,
} from "../app/lib/data/privateLlm";
import { required } from "../app/lib/data/protectedObjects";
import {
  initializeTenant,
  verifyTenantInitialized,
} from "../app/lib/crypto/initializeTenant";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const source: { tenant: string; phrase: string } = JSON.parse(
  await readFile(join(dirname(outputPath), "owner-recovery.json"), "utf8"),
);
const signal = new AbortController().signal;
const originalFetch = globalThis.fetch;
const requests: string[] = [];
const requestPaths = new Set<string>();
let lostReply = false;
let loseNextCommitReply = false;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    if (typeof args[1]?.body === "string") requests.push(args[1].body);
    const url = new URL(
      typeof args[0] === "string" || args[0] instanceof URL
        ? args[0]
        : args[0].url,
    );
    requestPaths.add(url.pathname);
    return Reflect.apply(target, receiver, args).then(
      async (response: Response) => {
        if (
          url.pathname === "/zerotrust.recovery.begin" &&
          loseNextCommitReply
        ) {
          const reply = await response.clone().json();
          if (reply[0]?.result) {
            loseNextCommitReply = false;
            lostReply = true;
            throw new TypeError(
              "Connection lost after the atomic recovery commit",
            );
          }
        }
        return response;
      },
    );
  },
});
const owner = createClient(endpoints[0], "native-recovery-former-owner");
const first = createClient(endpoints[1], "native-recovery-first");
const second = createClient(endpoints[0], "native-recovery-second");
const phrases = [source.phrase];
const passwords = [
  "Native-recovery-password-one-2026!",
  "Native-recovery-password-two-2026!",
];
try {
  await signIn(owner, {
    tenant: source.tenant,
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  const original = unlockedAccount()!;
  const session = await required(owner.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  const originalCompletion = await initializeTenant(owner, signal, duckDriver);
  // More than 64 keys exercises the server's inventory pagination and the
  // encrypted catalogue tree through its actual read/write endpoints.
  await provisionOwnedCollections(
    owner,
    subject,
    Array.from({ length: 72 }, (_, index) => {
      const scope = `test:recovery:${String(index).padStart(3, "0")}`;
      return {
        domain: `${scope}:master-data`,
        scope,
        facet: "master-data" as const,
        prefix: "canary:",
      };
    }),
    signal,
  );
  const canaryId = newAssistantId();
  const canary = "Vertrauliche Wiederherstellungsnotiz 482731";
  await preparePrivateLlm(owner, subject, signal);
  const personal = await openPrivateLlm(owner, signal);
  try {
    await personal.save("chat", canaryId, { text: canary });
  } finally {
    personal.close();
  }
  const draft = await recoveryDraft(
    first,
    source.tenant,
    source.phrase,
    passwords[0],
  );
  phrases.push(draft.newPhrase);
  const competingDraft = await recoveryDraft(
    second,
    source.tenant,
    source.phrase,
    passwords[0],
  );
  phrases.push(competingDraft.newPhrase);
  console.log("Native recovery: preparing two independently authorized plans");
  const plan = await recoveryPlan(first, draft);
  const competing = await recoveryPlan(second, competingDraft);
  assert.ok(plan.oldKeyEnvelopes.length > 64);
  const altered: MutateInput<"zerotrust.recovery.begin"> =
    structuredClone(plan);
  altered.domains = [];
  assert.ok((await first.mutate("zerotrust.recovery.begin", altered))[1]);
  const before = await required(
    first.query(
      "zerotrust.recovery.head",
      { tenant: source.tenant },
      { strategy: "network-only" },
    ),
  );
  assert.equal(before.generation, "1");
  console.log("Native recovery: competing commits on separate API replicas");
  const races = await Promise.all([
    first.mutate("zerotrust.recovery.begin", plan),
    second.mutate("zerotrust.recovery.begin", competing),
  ]);
  assert.equal(races.filter(([, error]) => !error).length, 1);
  const wonFirst = races[0][1] === null;
  const winner = wonFirst ? plan : competing;
  const winnerPhrase = wonFirst ? draft.newPhrase : competingDraft.newPhrase;
  const client: Client = wonFirst ? first : second;
  await required(client.mutate("zerotrust.recovery.begin", winner));
  await required(
    client.mutate("zerotrust.recovery.resume", {
      tenant: source.tenant,
      operation: winner.transition.operation,
    }),
  );
  assert.ok(
    (
      await owner.query("auth.check", undefined, { strategy: "network-only" })
    )[1],
  );
  await assert.rejects(() =>
    recoveryDraft(first, source.tenant, source.phrase, passwords[0]),
  );
  await assert.rejects(() =>
    recoveryDraft(first, source.tenant, createRecoveryPhrase(), passwords[0]),
  );
  await signIn(client, {
    tenant: source.tenant,
    username: winner.username,
    password: passwords[0],
  });
  assert.equal((await trustedHistory(client)).current.generation, "2");
  const incomplete = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(incomplete.initialization, null);
  assert.equal(incomplete.canInitialize, true);
  await assert.rejects(() =>
    verifyTenantInitialized(client, {
      ...incomplete,
      initialization: originalCompletion,
    }),
  );
  const completion = await initializeTenant(client, signal, duckDriver);
  assert.equal(completion.generation, "2");
  const recoveredBusiness = createBusinessClient(client, {
    productDriver: duckDriver,
  });
  const projectTitle = "Nach Wiederherstellung eingerichtete Baustelle 836291";
  const project = await required(
    recoveredBusiness.mutate("projects.create", { title: projectTitle }),
  );
  // The old personal area keeps its original subject after seed recovery.
  const { privateLlmCollection } = await import("../app/lib/data/privateLlm");
  const { protectedCollection } = await import(
    "../app/lib/data/protectedObjects"
  );
  async function readCanary(reader: Client) {
    const collection = await protectedCollection(
      reader,
      privateLlmCollection(subject),
      signal,
    );
    try {
      const object = (await collection.read()).find(
        (object) => object.envelope.object === `assistant:chat:${canaryId}`,
      );
      assert.ok(object);
      assert.deepEqual(object.value, {
        format: "sortsys-assistant-v1",
        kind: "chat",
        id: canaryId,
        value: { text: canary },
      });
    } finally {
      collection.close();
    }
  }
  const currentIdentities = await required(
    client.query("zerotrust.identities.list", undefined),
  );
  assert.deepEqual(
    currentIdentities.map((identity) => identity.subject),
    [winner.transition.nextAdministrator],
  );
  await readCanary(client);
  console.log("Native recovery: recovering again with the replacement phrase");
  const next = await recoveryDraft(
    first,
    source.tenant,
    winnerPhrase,
    passwords[1],
  );
  phrases.push(next.newPhrase);
  const nextPlan = await recoveryPlan(first, next);
  loseNextCommitReply = true;
  await commitRecovery(first, nextPlan);
  assert.equal(lostReply, true);
  await assert.rejects(() =>
    recoveryDraft(second, source.tenant, winnerPhrase, passwords[1]),
  );
  await assert.rejects(() =>
    recoveryDraft(second, source.tenant, source.phrase, passwords[1]),
  );
  await signIn(second, {
    tenant: source.tenant,
    username: nextPlan.username,
    password: passwords[1],
  });
  assert.equal((await trustedHistory(second)).current.generation, "3");
  const nextStatus = await required(
    second.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.equal(nextStatus.initialization, null);
  assert.equal(
    (await initializeTenant(second, signal, duckDriver)).generation,
    "3",
  );
  const nextBusiness = createBusinessClient(second, {
    productDriver: duckDriver,
  });
  const preservedProject = await required(
    nextBusiness.query("projects.get", { id: project.id }),
  );
  assert.equal(preservedProject.title, projectTitle);
  await required(
    nextBusiness.mutate("projects.create", {
      title: "Weitere Baustelle nach erneuter Wiederherstellung",
    }),
  );
  await readCanary(second);
  await recoveryDraft(first, source.tenant, next.newPhrase, passwords[1]);
  const wire = requests.join("\n");
  for (const path of [
    "zerotrust.recovery.inspect",
    "zerotrust.recovery.page",
    "zerotrust.recovery.registration",
    "zerotrust.recovery.catalog.read",
    "zerotrust.recovery.catalog.write",
    "zerotrust.recovery.begin",
    "auth.opaque.loginStart",
    "auth.opaque.loginFinish",
  ]) {
    assert.ok(
      requestPaths.has(`/${path}`),
      `Missing wire observation for ${path}`,
    );
  }
  for (const secret of [...phrases, ...passwords, canary, projectTitle])
    assert.equal(wire.includes(secret), false);
  assert.notEqual(
    original.vault.signingKey,
    unlockedAccount()!.vault.signingKey,
  );
  console.log(
    "Native recovery verified: seed-only proofs, paged encrypted catalogues, atomic competing plans, immediate phrase replacement, old-session revocation, historical decryption, lost-reply recovery and a second recovery with preserved old data.",
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  for (const client of [owner, first, second]) client.setToken(null);
}

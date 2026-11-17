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
  randomSecret,
  recoveryIdentity,
  recoveryRegistrationFrame,
  sign,
} from "@sortsys/zerotrust/sortsys";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import {
  commitRecovery,
  recoveryDraft,
  recoveryPlan,
  RecoveryNotStarted,
} from "../app/lib/crypto/recovery";
import {
  changeOwnPassword,
  lockCryptoSession,
  signIn,
  trustedHistory,
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
const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
assert.ok(root);
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const tenant = "existing-recovery-tenant";
const originalPassword = "Only-owner-knows-this-password-2026!";
const changedPassword = "Concurrent-owner-password-2026!";
const recoveredPassword = "Seed-restored-owner-password-2026!";
const repeatedPassword = "Second-seed-restored-owner-password-2026!";
const privateTitle = "Vertrauliche wiederhergestellte Position 684193";
const source = JSON.parse(
  await readFile(join(root, "owner-recovery.json"), "utf8"),
);
assert.equal(source.tenant, tenant);
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
const first = createClient(endpoints[0], "existing-recovery-first");
const second = createClient(endpoints[1], "existing-recovery-second");
let registration: MutateInput<"zerotrust.recovery.registration"> | undefined;
const observed: Client = {
  ...first,
  mutate: (async (path, input, options) => {
    if (path === "zerotrust.recovery.registration") {
      registration = structuredClone(
        input as MutateInput<"zerotrust.recovery.registration">,
      );
    }
    return first.mutate(path, input, options);
  }) as Client["mutate"],
};
const signal = new AbortController().signal;
const restoring = { restoreAdministrator: true };
async function head() {
  return required(
    first.query(
      "zerotrust.recovery.head",
      { tenant },
      { strategy: "network-only" },
    ),
  );
}
async function rejectsUnchanged(
  plan: Awaited<ReturnType<typeof recoveryPlan>>,
) {
  await assert.rejects(() => commitRecovery(second, plan), RecoveryNotStarted);
  assert.equal((await head()).generation, "1");
}
try {
  const [disclosed, denied] = await first.mutate("zerotrust.recovery.account", {
    tenant,
    generation: "1",
    nonce: base64(randomSecret()),
    proof: base64(new Uint8Array(64).fill(7)),
  });
  assert.equal(disclosed, null);
  assert.ok(
    denied,
    "An anonymous caller needs a valid seed proof to inspect the recovery target",
  );
  await signIn(first, {
    tenant,
    username: "builder",
    password: originalPassword,
  });
  await initializeTenant(first, signal, duckDriver);
  const original = await required(first.query("auth.sessionInfo", undefined));
  const subject = `user:${original.user.id}`;
  const originalIdentity = (await trustedHistory(first)).identityCertificate(
    subject,
    "1",
  );
  let business = createBusinessClient(first, { productDriver: duckDriver });
  const originalProfile = await required(
    business.query("users.get", { id: original.user.id }),
  );
  const product = await required(
    business.mutate("products.create", {
      name: privateTitle,
      customId: 684193,
      baseUnit: "Stk",
      description: "Unverändert nach zwei Wiederherstellungen",
    }),
  );
  business.dispose();
  const draft = await recoveryDraft(
    first,
    tenant,
    source.phrase,
    recoveredPassword,
    restoring,
  );
  assert.equal(draft.administrator?.subject, subject);
  assert.equal(draft.administrator?.username, "builder");
  const passwordRace = await recoveryPlan(observed, draft);
  assert.ok(registration);
  const staleRegistration = structuredClone(registration);
  await signIn(second, {
    tenant,
    username: "builder",
    password: originalPassword,
  });
  await changeOwnPassword(second, changedPassword);
  await rejectsUnchanged(passwordRace);
  const [, stale] = await first.mutate(
    "zerotrust.recovery.registration",
    staleRegistration,
  );
  assert.ok(stale instanceof RpcClientError);
  assert.equal(stale.code, "CONFLICT");
  const seed = await recoveryIdentity(source.phrase, tenant, "1");
  const wrongTarget = {
    ...staleRegistration,
    subject: subject === "user:1" ? "user:2" : "user:1",
    username: "someone-else",
  };
  wrongTarget.proof = await sign(
    seed.signingKey.privateKey,
    recoveryRegistrationFrame(
      tenant,
      wrongTarget.challengeId,
      wrongTarget.username,
      wrongTarget.subject,
      wrongTarget.registrationRequest,
      wrongTarget.accountVersion,
    ),
  );
  const [, substituted] = await second.mutate(
    "zerotrust.recovery.registration",
    wrongTarget,
  );
  assert.ok(
    substituted,
    "A seed-authorized reuse must target the current primary administrator",
  );
  const aliasRace = await recoveryPlan(first, draft);
  assert.notEqual(aliasRace.accountVersion, passwordRace.accountVersion);
  business = createBusinessClient(second, { productDriver: duckDriver });
  await required(
    business.mutate("users.update", {
      id: original.user.id,
      data: { username: "builder.renamed" },
    }),
  );
  business.dispose();
  await rejectsUnchanged(aliasRace);
  await lockCryptoSession();
  assert.equal(unlockedAccount(), null);
  const plan = await recoveryPlan(first, draft);
  assert.equal(plan.username, "builder.renamed");
  assert.equal(plan.nextSetup.owner.user, subject);
  assert.notEqual(plan.accountVersion, aliasRace.accountVersion);
  await commitRecovery(second, plan);
  await commitRecovery(first, plan);
  assert.equal((await head()).generation, "2");
  assert.ok(
    (
      await second.query("auth.check", undefined, { strategy: "network-only" })
    )[1],
  );
  await assert.rejects(() =>
    recoveryDraft(first, tenant, source.phrase, recoveredPassword, restoring),
  );
  for (const password of [originalPassword, changedPassword]) {
    await assert.rejects(() =>
      signIn(first, { tenant, username: "builder.renamed", password }),
    );
  }
  await signIn(first, {
    tenant,
    username: plan.username,
    password: recoveredPassword,
  });
  assert.equal(
    (await required(first.query("auth.sessionInfo", undefined))).user.id,
    original.user.id,
  );
  const history = await trustedHistory(first);
  assert.deepEqual(history.identityCertificate(subject, "1"), originalIdentity);
  assert.notEqual(
    history.identityCertificate(subject, "1").signingKey,
    history.identityCertificate(subject, "2").signingKey,
  );
  business = createBusinessClient(first, { productDriver: duckDriver });
  const firstProfile = await required(
    business.query("users.get", { id: original.user.id }),
  );
  assert.equal(firstProfile.firstName, originalProfile.firstName);
  assert.equal(firstProfile.lastName, originalProfile.lastName);
  assert.equal(firstProfile.username, "builder.renamed");
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    privateTitle,
  );
  business.dispose();
  await lockCryptoSession();
  const nextDraft = await recoveryDraft(
    second,
    tenant,
    draft.newPhrase,
    repeatedPassword,
    restoring,
  );
  const nextPlan = await recoveryPlan(second, nextDraft);
  await commitRecovery(first, nextPlan);
  await assert.rejects(() =>
    recoveryDraft(second, tenant, draft.newPhrase, repeatedPassword, restoring),
  );
  await assert.rejects(() =>
    signIn(second, {
      tenant,
      username: plan.username,
      password: recoveredPassword,
    }),
  );
  await signIn(second, {
    tenant,
    username: nextPlan.username,
    password: repeatedPassword,
  });
  const restored = await required(second.query("auth.sessionInfo", undefined));
  assert.equal(restored.user.id, original.user.id);
  assert.equal(restored.user.username, "builder.renamed");
  assert.deepEqual(restored.roles, [":admin"]);
  business = createBusinessClient(second, { productDriver: duckDriver });
  const secondProfile = await required(
    business.query("users.get", { id: original.user.id }),
  );
  assert.equal(secondProfile.firstName, originalProfile.firstName);
  assert.equal(secondProfile.lastName, originalProfile.lastName);
  assert.equal(secondProfile.username, "builder.renamed");
  assert.equal(
    (await required(business.query("products.get", { id: product.id }))).name,
    privateTitle,
  );
  business.dispose();
  const forbidden = [
    source.phrase,
    draft.newPhrase,
    nextDraft.newPhrase,
    originalPassword,
    changedPassword,
    recoveredPassword,
    repeatedPassword,
    privateTitle,
  ];
  for (const secret of forbidden)
    assert.equal(
      wire.some((request) => request.includes(secret)),
      false,
    );
  await writeFile(
    outputPath,
    JSON.stringify({
      success: true,
      stableAdministrator: original.user.id,
      passwordRaceRejected: true,
      aliasRaceRejected: true,
      repeatedSeedRotation: true,
      businessContentsPreserved: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  first.setToken(null);
  second.setToken(null);
  await lockCryptoSession();
}
